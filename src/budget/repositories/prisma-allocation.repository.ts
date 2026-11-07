import { Injectable } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import type { AllocationRow, IAllocationRepository } from '../interfaces/allocation-repository.interface';
import { PrismaErrorMapper } from '../../common/errors/prisma-error.mapper';
import { DomainException } from '../../common/errors/domain.exception';

interface RawAllocationRow {
  id: string;
  user_id: string;
  period_id: string;
  category_id: string;
  amount_cents: bigint;
  source: string;
  note: string | null;
  deleted_at: Date | null;
  created_at: Date;
}

function mapRow(r: RawAllocationRow): AllocationRow {
  return {
    id: r.id,
    userId: r.user_id,
    periodId: r.period_id,
    categoryId: r.category_id,
    amountCents: r.amount_cents,
    source: r.source as 'manual' | 'rollover',
    note: r.note,
    deletedAt: r.deleted_at,
    createdAt: r.created_at,
  };
}

/**
 * A08 — dueña de `budget_entries` para asignación manual y rollover
 * (T-R12: el único otro lugar que escribe esa tabla es
 * `PrismaTransactionRepository`, para compensaciones de captura tardía).
 * INSERT siempre vía `$queryRaw`: R7/R11 son triggers de TASK-db.md que
 * los métodos tipados de Prisma envolverían sin `code`/`meta`.
 */
@Injectable()
export class PrismaAllocationRepository implements IAllocationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(
    userId: string,
    periodId: string,
    categoryId: string,
    amountCents: bigint,
    source: 'manual' | 'rollover',
    note: string | null,
  ): Promise<AllocationRow> {
    try {
      const rows = await this.prisma.$queryRaw<RawAllocationRow[]>`
        INSERT INTO budget_entries (id, user_id, period_id, category_id, amount_cents, source, note)
        VALUES (gen_random_uuid(), ${userId}::uuid, ${periodId}::uuid, ${categoryId}::uuid, ${amountCents}, ${source}::budget_entry_source, ${note})
        RETURNING id, user_id, period_id, category_id, amount_cents, source, note, deleted_at, created_at
      `;
      return mapRow(rows[0]);
    } catch (e) {
      throw PrismaErrorMapper.toDomainException(e);
    }
  }

  async findManyByPeriod(userId: string, periodId: string): Promise<AllocationRow[]> {
    const rows = await this.prisma.budgetEntry.findMany({
      where: { userId, periodId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      periodId: r.periodId,
      categoryId: r.categoryId,
      amountCents: r.amountCents,
      source: r.source === 'Rollover' ? 'rollover' : 'manual',
      note: r.note,
      deletedAt: r.deletedAt,
      createdAt: r.createdAt,
    }));
  }

  async findById(userId: string, id: string): Promise<AllocationRow | null> {
    const row = await this.prisma.budgetEntry.findFirst({ where: { id, userId, deletedAt: null } });
    if (!row) return null;
    return {
      id: row.id,
      userId: row.userId,
      periodId: row.periodId,
      categoryId: row.categoryId,
      amountCents: row.amountCents,
      source: row.source === 'Rollover' ? 'rollover' : 'manual',
      note: row.note,
      deletedAt: row.deletedAt,
      createdAt: row.createdAt,
    };
  }

  async softDelete(userId: string, id: string): Promise<AllocationRow> {
    try {
      const rows = await this.prisma.$queryRaw<RawAllocationRow[]>`
        UPDATE budget_entries SET deleted_at = now()
        WHERE id = ${id}::uuid AND user_id = ${userId}::uuid
        RETURNING id, user_id, period_id, category_id, amount_cents, source, note, deleted_at, created_at
      `;
      return mapRow(rows[0]);
    } catch (e) {
      throw PrismaErrorMapper.toDomainException(e);
    }
  }

  async countLiveByPeriod(userId: string, periodId: string): Promise<number> {
    return this.prisma.budgetEntry.count({ where: { userId, periodId, deletedAt: null } });
  }

  async sumAssignedTx(tx: Prisma.TransactionClient, userId: string, periodId: string, categoryId: string): Promise<bigint> {
    const rows = await tx.$queryRaw<Array<{ total: bigint }>>`
      SELECT COALESCE(SUM(amount_cents), 0)::bigint AS total
      FROM budget_entries
      WHERE user_id = ${userId}::uuid AND period_id = ${periodId}::uuid AND category_id = ${categoryId}::uuid
        AND deleted_at IS NULL
    `;
    return rows[0].total;
  }

  async insertTx(
    tx: Prisma.TransactionClient,
    userId: string,
    periodId: string,
    categoryId: string,
    amountCents: bigint,
    source: 'manual' | 'rollover',
    note: string | null,
  ): Promise<AllocationRow> {
    try {
      const rows = await tx.$queryRaw<RawAllocationRow[]>`
        INSERT INTO budget_entries (id, user_id, period_id, category_id, amount_cents, source, note)
        VALUES (gen_random_uuid(), ${userId}::uuid, ${periodId}::uuid, ${categoryId}::uuid, ${amountCents}, ${source}::budget_entry_source, ${note})
        RETURNING id, user_id, period_id, category_id, amount_cents, source, note, deleted_at, created_at
      `;
      return mapRow(rows[0]);
    } catch (e) {
      if (e instanceof DomainException) throw e;
      throw PrismaErrorMapper.toDomainException(e);
    }
  }
}
