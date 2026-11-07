import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import type { ITransactionRepository } from '../interfaces/transaction-repository.interface';
import type { EntryDraft } from '../entry-builders';
import type { BudgetCompensationDraft } from '../budget-compensations';
import type {
  CreateTransactionResult,
  CursorPage,
  EntryCursor,
  EntryRow,
  EntryWithTransaction,
  TransactionDraft,
  TransactionFilter,
  TransactionRow,
  TransactionWithEntries,
  TxCursor,
} from '../types';
import { IdempotencyInFlightException } from '../exceptions/idempotency-in-flight.exception';
import { encodeCursor } from '../../../common/pagination/cursor';
import { PrismaErrorMapper } from '../../../common/errors/prisma-error.mapper';
import { DomainException } from '../../../common/errors/domain.exception';

interface RawTransactionRow {
  id: string;
  user_id: string;
  booked_at: Date;
  description: string;
  idempotency_key: string | null;
  reverses_transaction_id: string | null;
  created_at: Date;
}

function mapTransactionRow(r: RawTransactionRow): TransactionRow {
  return {
    id: r.id,
    userId: r.user_id,
    bookedAt: r.booked_at,
    description: r.description,
    idempotencyKey: r.idempotency_key,
    reversesTransactionId: r.reverses_transaction_id,
    createdAt: r.created_at,
  };
}

/**
 * TASK-api.md §5.1 — S-R1 vive aquí y solo aquí. Usa la forma CALLBACK de
 * `$transaction` (no la de arreglo): necesita ramificar según si el
 * `INSERT ... ON CONFLICT DO NOTHING` devolvió fila o no, y la forma de
 * arreglo no permite lógica condicional.
 *
 * `SET CONSTRAINTS ALL IMMEDIATE` como último statement antes del
 * `COMMIT` implícito — verificado empíricamente en esta sesión: sin él,
 * un fallo de R1/R2/R4/R9 (DEFERRABLE INITIALLY DEFERRED) en la forma
 * callback de `$transaction` se traga en silencio (la promesa resuelve
 * sin lanzar, y la fila nunca se comprometió). Con él, el fallo se
 * evalúa como un statement normal: lanza `PrismaClientKnownRequestError`
 * con `P2010`/`meta.code` intacto, que `PrismaErrorMapper` ya sabe leer.
 */
@Injectable()
export class PrismaTransactionRepository implements ITransactionRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async createWithEntries(
    userId: string,
    draft: TransactionDraft,
    entries: EntryDraft[],
    compensations: BudgetCompensationDraft[] = [],
  ): Promise<CreateTransactionResult> {
    try {
      return await this.runCreateWithEntries(userId, draft, entries, compensations);
    } catch (e) {
      // Las excepciones de dominio que ya lanzamos nosotros mismos
      // (p. ej. IdempotencyInFlightException) se propagan tal cual — solo
      // los errores crudos de Postgres pasan por el mapeo.
      if (e instanceof DomainException) {
        throw e;
      }
      throw PrismaErrorMapper.toDomainException(e);
    }
  }

  private async runCreateWithEntries(
    userId: string,
    draft: TransactionDraft,
    entries: EntryDraft[],
    compensations: BudgetCompensationDraft[],
  ): Promise<CreateTransactionResult> {
    return this.prisma.$transaction(async (tx) => {
      const inserted = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO transactions (id, user_id, booked_at, description, idempotency_key, reverses_transaction_id)
        VALUES (
          ${draft.id}::uuid,
          ${userId}::uuid,
          ${draft.bookedAt},
          ${draft.description},
          ${draft.idempotencyKey ?? null}::uuid,
          ${draft.reversesTransactionId ?? null}::uuid
        )
        ON CONFLICT (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
        RETURNING id
      `;

      if (inserted.length > 0) {
        const entryRows: EntryRow[] = entries.map((e) => ({
          id: randomUUID(),
          transactionId: draft.id,
          userId,
          accountId: e.accountId,
          amountCents: e.amountCents,
          createdAt: new Date(),
        }));

        // $executeRaw, no tx.entry.createMany(): verificado empíricamente
        // en esta sesión — los métodos tipados de Prisma (createMany,
        // create, update...) envuelven CUALQUIER error como
        // PrismaClientUnknownRequestError sin `code`/`meta`, incluso
        // cuando el SQLSTATE real (p. ej. P1011) sí viaja enterrado en el
        // texto de debug de Postgres. Solo $queryRaw/$executeRaw
        // preservan la forma que PrismaErrorMapper sabe leer.
        for (const e of entryRows) {
          await tx.$executeRaw`
            INSERT INTO entries (id, transaction_id, user_id, account_id, amount_cents)
            VALUES (${e.id}::uuid, ${e.transactionId}::uuid, ${e.userId}::uuid, ${e.accountId}::uuid, ${e.amountCents})
          `;
        }

        for (const c of compensations) {
          await tx.$executeRaw`
            INSERT INTO budget_entries (id, user_id, period_id, category_id, amount_cents, source, note)
            VALUES (gen_random_uuid(), ${userId}::uuid, ${c.periodId}::uuid, ${c.categoryId}::uuid, ${c.amountCents}, 'manual', ${c.note})
          `;
        }

        // Fuerza la evaluación de R1/R2/R4/R9 aquí, como statement
        // normal — ver nota de clase.
        await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');

        const [transactionRaw] = await tx.$queryRaw<RawTransactionRow[]>`
          SELECT id, user_id, booked_at, description, idempotency_key, reverses_transaction_id, created_at
          FROM transactions WHERE id = ${draft.id}::uuid
        `;

        return { transaction: mapTransactionRow(transactionRaw), entries: entryRows, created: true };
      }

      // No insertó: la llave ya existía. Se busca la fila real.
      const existingRows = await tx.$queryRaw<RawTransactionRow[]>`
        SELECT id, user_id, booked_at, description, idempotency_key, reverses_transaction_id, created_at
        FROM transactions
        WHERE user_id = ${userId}::uuid AND idempotency_key = ${draft.idempotencyKey ?? null}::uuid
      `;

      if (existingRows.length === 0) {
        // La escritura original no ha hecho COMMIT todavía — P-04: se
        // propaga tal cual, de una sola vez, sin esperar ni volver a
        // intentar del lado del servidor (ver T-A10).
        throw new IdempotencyInFlightException();
      }

      const transactionRow = mapTransactionRow(existingRows[0]);
      const existingEntries = await tx.entry.findMany({ where: { userId, transactionId: transactionRow.id } });

      return { transaction: transactionRow, entries: existingEntries, created: false };
    });
  }

  async findById(userId: string, id: string): Promise<TransactionWithEntries | null> {
    const transaction = await this.prisma.transaction.findFirst({ where: { id, userId } });
    if (!transaction) return null;
    const entries = await this.prisma.entry.findMany({ where: { userId, transactionId: id } });
    return { ...transaction, entries };
  }

  async findByIdempotencyKey(userId: string, key: string): Promise<TransactionWithEntries | null> {
    const transaction = await this.prisma.transaction.findFirst({ where: { userId, idempotencyKey: key } });
    if (!transaction) return null;
    const entries = await this.prisma.entry.findMany({ where: { userId, transactionId: transaction.id } });
    return { ...transaction, entries };
  }

  async findReversalOf(userId: string, transactionId: string): Promise<TransactionRow | null> {
    return this.prisma.transaction.findFirst({ where: { userId, reversesTransactionId: transactionId } });
  }

  /** R6 permite actualizar `description` y nada más — único método de escritura fuera de `createWithEntries`. */
  async updateDescription(userId: string, id: string, description: string): Promise<TransactionRow> {
    return this.prisma.transaction.update({ where: { id }, data: { description } });
  }

  async findManyByCursor(
    userId: string,
    filter: TransactionFilter,
    cursor: TxCursor | null,
    limit: number,
  ): Promise<CursorPage<TransactionWithEntries>> {
    const conditions: Prisma.Sql[] = [Prisma.sql`t.user_id = ${userId}::uuid`];
    if (filter.from) conditions.push(Prisma.sql`t.booked_at >= ${filter.from}::date`);
    if (filter.to) conditions.push(Prisma.sql`t.booked_at <= ${filter.to}::date`);
    if (cursor) conditions.push(Prisma.sql`(t.booked_at, t.id) < (${cursor.b}::date, ${cursor.t}::uuid)`);
    if (filter.accountId) {
      conditions.push(
        Prisma.sql`EXISTS (SELECT 1 FROM entries e WHERE e.transaction_id = t.id AND e.account_id = ${filter.accountId}::uuid)`,
      );
    }
    if (filter.categoryId) {
      conditions.push(
        Prisma.sql`EXISTS (SELECT 1 FROM entries e WHERE e.transaction_id = t.id AND e.account_id = ${filter.categoryId}::uuid)`,
      );
    }

    const rows = await this.prisma.$queryRaw<RawTransactionRow[]>`
      SELECT t.id, t.user_id, t.booked_at, t.description, t.idempotency_key, t.reverses_transaction_id, t.created_at
      FROM transactions t
      WHERE ${Prisma.join(conditions, ' AND ')}
      ORDER BY t.booked_at DESC, t.created_at DESC, t.id DESC
      LIMIT ${limit + 1}
    `;

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).map(mapTransactionRow);
    const withEntries: TransactionWithEntries[] = await Promise.all(
      page.map(async (t) => ({ ...t, entries: await this.prisma.entry.findMany({ where: { userId, transactionId: t.id } }) })),
    );

    const last = page[page.length - 1];
    const nextCursor = hasMore && last ? encodeCursor({ b: last.bookedAt.toISOString().slice(0, 10), t: last.id }) : null;

    return { data: withEntries, nextCursor };
  }

  async findEntriesByAccountCursor(
    userId: string,
    accountId: string,
    cursor: EntryCursor | null,
    limit: number,
  ): Promise<CursorPage<EntryWithTransaction>> {
    const conditions: Prisma.Sql[] = [Prisma.sql`e.user_id = ${userId}::uuid`, Prisma.sql`e.account_id = ${accountId}::uuid`];
    if (cursor) {
      conditions.push(
        Prisma.sql`(t.booked_at, t.id, e.id) < (${cursor.b}::date, ${cursor.t}::uuid, ${cursor.e}::uuid)`,
      );
    }

    const rows = await this.prisma.$queryRaw<
      Array<{ transaction_id: string; booked_at: Date; description: string; amount_cents: bigint; created_at: Date; entry_id: string }>
    >`
      SELECT e.id AS entry_id, t.id AS transaction_id, t.booked_at, t.description, e.amount_cents, e.created_at
      FROM entries e
      JOIN transactions t ON t.id = e.transaction_id
      WHERE ${Prisma.join(conditions, ' AND ')}
      ORDER BY t.booked_at DESC, t.id DESC, e.id DESC
      LIMIT ${limit + 1}
    `;

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const data: EntryWithTransaction[] = page.map((r) => ({
      transactionId: r.transaction_id,
      bookedAt: r.booked_at,
      description: r.description,
      amountCents: r.amount_cents,
      createdAt: r.created_at,
    }));

    const lastRaw = page[page.length - 1];
    const nextCursor =
      hasMore && lastRaw
        ? encodeCursor({ b: lastRaw.booked_at.toISOString().slice(0, 10), t: lastRaw.transaction_id, e: lastRaw.entry_id })
        : null;

    return { data, nextCursor };
  }
}
