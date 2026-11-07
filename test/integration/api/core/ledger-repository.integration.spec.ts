import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { pool, seedFixtureCommitted, type Fixture } from '../_helpers/seed';

// Grupo A-core (TASK-api.md §11) — idempotencia y compensación a nivel de
// repository, sin HTTP: los endpoints de /transactions/* son A07, loop 2.
// `PrismaTransactionRepository`/`ITransactionRepository` no existen
// todavía — rojo por diseño hasta que el loop de implementación los cree.
import { PrismaTransactionRepository } from '../../../../src/shared/ledger/repositories/prisma-transaction.repository';
import { IdempotencyInFlightException } from '../../../../src/shared/ledger/exceptions/idempotency-in-flight.exception';
import { ClosedPeriodException } from '../../../../src/budget/exceptions/closed-period.exception';

const REPOSITORY_PATH = join(__dirname, '../../../../src/shared/ledger/repositories/prisma-transaction.repository.ts');

function draft(overrides: Partial<{ id: string; bookedAt: string; description: string; idempotencyKey: string | null; reversesTransactionId: string | null }> = {}) {
  return {
    id: overrides.id ?? randomUUID(),
    bookedAt: new Date(overrides.bookedAt ?? '2026-08-09'),
    description: overrides.description ?? 'Wifi agosto',
    idempotencyKey: overrides.idempotencyKey ?? randomUUID(),
    reversesTransactionId: overrides.reversesTransactionId ?? null,
  };
}

async function countRows(table: string, userId: string): Promise<number> {
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE user_id = $1`, [userId]);
  return rows[0].n as number;
}

describe('ITransactionRepository — ledger-repository.integration.spec.ts (Grupo A-core)', () => {
  const prisma = new PrismaClient();
  const repository = new PrismaTransactionRepository(prisma);
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await seedFixtureCommitted();
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await pool.end();
  });

  it('T-A01: createWithEntries con idempotencyKey nueva → created:true, 1 fila, entries escritos', async () => {
    const userId = fixture.a.userId;
    const key = randomUUID();
    const txDraft = draft({ idempotencyKey: key });

    const result = await repository.createWithEntries(userId, txDraft, [
      { accountId: fixture.a.accounts.nu, amountCents: -70000n },
      { accountId: fixture.a.accounts.comida, amountCents: 70000n },
    ]);

    expect(result.created).toBe(true);
    expect(result.transaction.id).toBe(txDraft.id);
    expect(result.entries).toHaveLength(2);

    const { rows } = await pool.query('SELECT count(*)::int AS n FROM transactions WHERE id = $1', [txDraft.id]);
    expect(rows[0].n).toBe(1);
  });

  it('T-A02: repetir el mismo draft con la misma llave → created:false, mismo id, count sin cambio', async () => {
    const userId = fixture.a.userId;
    const key = randomUUID();
    const txDraft = draft({ idempotencyKey: key });
    const entries = [
      { accountId: fixture.a.accounts.nu, amountCents: -1000n },
      { accountId: fixture.a.accounts.comida, amountCents: 1000n },
    ];

    const first = await repository.createWithEntries(userId, txDraft, entries);
    const before = await countRows('transactions', userId);
    const second = await repository.createWithEntries(userId, txDraft, entries);
    const after = await countRows('transactions', userId);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.transaction.id).toBe(first.transaction.id);
    expect(after).toBe(before);
  });

  it('T-A03: repetir con un draft DISTINTO y la misma llave → created:false, devuelve la transacción original', async () => {
    const userId = fixture.a.userId;
    const key = randomUUID();
    const original = draft({ idempotencyKey: key, description: 'original' });
    await repository.createWithEntries(userId, original, [
      { accountId: fixture.a.accounts.nu, amountCents: -2000n },
      { accountId: fixture.a.accounts.comida, amountCents: 2000n },
    ]);

    const different = draft({ idempotencyKey: key, description: 'distinto, no debería escribirse' });
    const result = await repository.createWithEntries(userId, different, [
      { accountId: fixture.a.accounts.nu, amountCents: -9999n },
      { accountId: fixture.a.accounts.comida, amountCents: 9999n },
    ]);

    expect(result.created).toBe(false);
    expect(result.transaction.id).toBe(original.id);
    expect(result.transaction.description).toBe('original');
  });

  it('T-A06: misma llave, usuario distinto (U2) → created:true — el índice es (user_id, idempotency_key)', async () => {
    const key = randomUUID();
    const draftA = draft({ idempotencyKey: key });
    const draftB = draft({ idempotencyKey: key });

    const resultA = await repository.createWithEntries(fixture.a.userId, draftA, [
      { accountId: fixture.a.accounts.nu, amountCents: -3000n },
      { accountId: fixture.a.accounts.comida, amountCents: 3000n },
    ]);
    const resultB = await repository.createWithEntries(fixture.b.userId, draftB, [
      { accountId: fixture.b.accounts.nu, amountCents: -3000n },
      { accountId: fixture.b.accounts.comida, amountCents: 3000n },
    ]);

    expect(resultA.created).toBe(true);
    expect(resultB.created).toBe(true);
  });

  it('T-A07/T-A08: dos createWithEntries concurrentes con la misma llave, Promise.all sobre conexiones distintas → nunca dos created:true', async () => {
    const userId = fixture.a.userId;
    const key = randomUUID();
    const id = randomUUID();
    const entries = [
      { accountId: fixture.a.accounts.nu, amountCents: -4000n },
      { accountId: fixture.a.accounts.comida, amountCents: 4000n },
    ];

    // Dos PrismaClient/repository independientes → dos conexiones
    // distintas del pool, ambas llamadas dentro del mismo `it()`. La
    // suite corre con --runInBand; dos `it()` separados nunca competirían
    // de verdad.
    const prismaB = new PrismaClient();
    const repositoryB = new PrismaTransactionRepository(prismaB);

    const attempt = (repo: PrismaTransactionRepository, description: string) =>
      repo
        .createWithEntries(userId, draft({ id, idempotencyKey: key, description }), entries)
        .then((r: { created: boolean; transaction: { id: string } }) => ({ ok: true as const, result: r }))
        .catch((e: unknown) => ({ ok: false as const, error: e }));

    try {
      const [outcomeA, outcomeB] = await Promise.all([
        attempt(repository, 'intento A'),
        attempt(repositoryB, 'intento B'),
      ]);

      const createdCount = [outcomeA, outcomeB].filter((o) => o.ok && o.result.created).length;
      expect(createdCount).toBe(1);

      const failed = [outcomeA, outcomeB].find((o) => !o.ok);
      if (failed && !failed.ok) {
        expect(failed.error).toBeInstanceOf(IdempotencyInFlightException);
        expect((failed.error as IdempotencyInFlightException).code).toBe('IDEMPOTENCY_IN_FLIGHT');
      }

      const { rows } = await pool.query('SELECT count(*)::int AS n FROM transactions WHERE idempotency_key = $1', [key]);
      expect(rows[0].n).toBe(1);
    } finally {
      await prismaB.$disconnect();
    }
  });

  it('T-A10: prisma-transaction.repository.ts no contiene sleep/setTimeout/retry/backoff — P-04 sin reintento', () => {
    const source = readFileSync(REPOSITORY_PATH, 'utf-8');

    expect(source).not.toMatch(/\bsleep\s*\(/i);
    expect(source).not.toMatch(/\bsetTimeout\s*\(/);
    expect(source).not.toMatch(/\bretry\b/i);
    expect(source).not.toMatch(/\bbackoff\b/i);
  });

  describe('compensaciones (§4.9) — periodos reales sembrados a mano', () => {
    it('T-A11: createWithEntries con dos compensaciones → ambos budget_entries en la misma transacción de DB', async () => {
      const userId = fixture.a.userId;
      const key = randomUUID();
      const txDraft = draft({ idempotencyKey: key });

      const result = await repository.createWithEntries(
        userId,
        txDraft,
        [
          { accountId: fixture.a.accounts.nu, amountCents: -5000n },
          { accountId: fixture.a.accounts.comida, amountCents: 5000n },
        ],
        [
          {
            periodId: fixture.a.periods.p1,
            categoryId: fixture.a.accounts.comida,
            amountCents: -5000n,
            note: `Ajuste por captura tardía — tx ${txDraft.id}, fecha 2026-08-09`,
          },
          {
            periodId: fixture.a.periods.p1,
            categoryId: fixture.a.accounts.salud,
            amountCents: -1000n,
            note: `Ajuste por captura tardía — tx ${txDraft.id}, fecha 2026-08-09`,
          },
        ],
      );

      expect(result.created).toBe(true);

      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM budget_entries WHERE period_id = $1 AND note LIKE $2`,
        [fixture.a.periods.p1, `%${txDraft.id}%`],
      );
      expect(rows[0].n).toBe(2);
    });

    it('T-A12: repetir esa llamada con la misma llave → created:false, cero budget_entries nuevos', async () => {
      const userId = fixture.a.userId;
      const key = randomUUID();
      const txDraft = draft({ idempotencyKey: key });
      const compensations = [
        {
          periodId: fixture.a.periods.p1,
          categoryId: fixture.a.accounts.comida,
          amountCents: -1500n,
          note: `Ajuste por captura tardía — tx ${txDraft.id}, fecha 2026-08-09`,
        },
      ];
      const entries = [
        { accountId: fixture.a.accounts.nu, amountCents: -1500n },
        { accountId: fixture.a.accounts.comida, amountCents: 1500n },
      ];

      await repository.createWithEntries(userId, txDraft, entries, compensations);
      const before = await countRows('budget_entries', userId);
      const second = await repository.createWithEntries(userId, txDraft, entries, compensations);
      const after = await countRows('budget_entries', userId);

      expect(second.created).toBe(false);
      expect(after).toBe(before);
    });

    it('T-A13: compensación apuntando a un periodo CERRADO → ClosedPeriodException (PERIOD_CLOSED), cero filas en las tres tablas', async () => {
      const userId = fixture.a.userId;
      const closedPeriodId = randomUUID();
      await pool.query(
        `INSERT INTO budget_periods (id, user_id, starts_on, ends_on, closed_at)
         VALUES ($1, $2, '2026-07-01', '2026-07-15', now())`,
        [closedPeriodId, userId],
      );

      const txDraft = draft({ idempotencyKey: randomUUID() });
      const entries = [
        { accountId: fixture.a.accounts.nu, amountCents: -6000n },
        { accountId: fixture.a.accounts.comida, amountCents: 6000n },
      ];
      const compensations = [
        {
          periodId: closedPeriodId,
          categoryId: fixture.a.accounts.comida,
          amountCents: -6000n,
          note: `Ajuste por captura tardía — tx ${txDraft.id}, fecha 2026-08-09`,
        },
      ];

      const txCountBefore = await countRows('transactions', userId);
      const entryCountBefore = await countRows('entries', userId);
      const beCountBefore = await countRows('budget_entries', userId);

      // Una sola llamada: es una escritura real contra Postgres, no una
      // función pura — dos intentos no garantizan probar el mismo caso
      // dos veces, y el segundo dependería de que el primero haya
      // revertido limpio (que es justo lo que este test verifica, no
      // algo que deba asumir de antemano).
      try {
        await repository.createWithEntries(userId, txDraft, entries, compensations);
        fail('debía lanzar ClosedPeriodException');
      } catch (e) {
        expect(e).toBeInstanceOf(ClosedPeriodException);
        expect((e as ClosedPeriodException).code).toBe('PERIOD_CLOSED');
      }

      expect(await countRows('transactions', userId)).toBe(txCountBefore);
      expect(await countRows('entries', userId)).toBe(entryCountBefore);
      expect(await countRows('budget_entries', userId)).toBe(beCountBefore);
    });
  });
});
