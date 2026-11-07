import { Injectable } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import type { IBudgetPeriodRepository } from '../interfaces/period-repository.interface';
import type { CreatePeriodData, PeriodRow, UpdatePeriodDatesData } from '../types';
import type { OffsetPage, Paged } from '../../../common/pagination/types';
import { PrismaErrorMapper } from '../../../common/errors/prisma-error.mapper';
import { DomainException } from '../../../common/errors/domain.exception';

interface RawPeriodRow {
  id: string;
  user_id: string;
  starts_on: Date;
  ends_on: Date;
  closed_at: Date | null;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function mapPeriodRow(r: RawPeriodRow): PeriodRow {
  return {
    id: r.id,
    userId: r.user_id,
    startsOn: r.starts_on,
    endsOn: r.ends_on,
    closedAt: r.closed_at,
    deletedAt: r.deleted_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * A01b (TASK-api.md §6.8) — compartida por A03/A07/A09 (resolución de
 * "qué periodo cubre esta fecha" para la compensación de captura tardía,
 * §2.3) y dueña real del algoritmo de cierre y del `FOR UPDATE` de
 * asignaciones para A08.
 *
 * Todo INSERT/UPDATE pasa por `$queryRaw`/`$executeRaw`, nunca por los
 * métodos tipados de Prisma — mismo hallazgo empírico que dejó
 * `PrismaTransactionRepository` en A03: los métodos tipados envuelven
 * cualquier violación de constraint no nativa de Prisma (aquí, el
 * `EXCLUDE` de `budget_periods_no_overlap`, 23P01) como
 * `PrismaClientUnknownRequestError`, sin `code`/`meta`.
 */
@Injectable()
export class PrismaBudgetPeriodRepository implements IBudgetPeriodRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async runInTransaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    try {
      return await this.prisma.$transaction(fn);
    } catch (e) {
      if (e instanceof DomainException) {
        throw e;
      }
      throw PrismaErrorMapper.toDomainException(e);
    }
  }

  async findPeriodCoveringDate(userId: string, date: string, tx?: Prisma.TransactionClient): Promise<PeriodRow | null> {
    const client = tx ?? this.prisma;
    const rows = await client.$queryRaw<RawPeriodRow[]>`
      SELECT id, user_id, starts_on, ends_on, closed_at, deleted_at, created_at, updated_at
      FROM budget_periods
      WHERE user_id = ${userId}::uuid AND deleted_at IS NULL
        AND starts_on <= ${date}::date AND ends_on >= ${date}::date
      LIMIT 1
    `;
    return rows[0] ? mapPeriodRow(rows[0]) : null;
  }

  async findOpenPeriodCoveringDate(userId: string, date: string, tx?: Prisma.TransactionClient): Promise<PeriodRow | null> {
    const client = tx ?? this.prisma;
    const rows = await client.$queryRaw<RawPeriodRow[]>`
      SELECT id, user_id, starts_on, ends_on, closed_at, deleted_at, created_at, updated_at
      FROM budget_periods
      WHERE user_id = ${userId}::uuid AND deleted_at IS NULL AND closed_at IS NULL
        AND starts_on <= ${date}::date AND ends_on >= ${date}::date
      LIMIT 1
    `;
    return rows[0] ? mapPeriodRow(rows[0]) : null;
  }

  async findById(userId: string, id: string): Promise<PeriodRow | null> {
    const period = await this.prisma.budgetPeriod.findFirst({ where: { id, userId, deletedAt: null } });
    return period ? { ...period, deletedAt: period.deletedAt } : null;
  }

  async findMany(userId: string, filter: { status?: 'open' | 'closed' }, page: OffsetPage): Promise<Paged<PeriodRow>> {
    const where: Prisma.BudgetPeriodWhereInput = {
      userId,
      deletedAt: null,
      ...(filter.status === 'open' ? { closedAt: null } : {}),
      ...(filter.status === 'closed' ? { closedAt: { not: null } } : {}),
    };

    const [data, total] = await Promise.all([
      this.prisma.budgetPeriod.findMany({
        where,
        skip: (page.page - 1) * page.pageSize,
        take: page.pageSize,
        orderBy: { startsOn: 'desc' },
      }),
      this.prisma.budgetPeriod.count({ where }),
    ]);

    return { data, page: page.page, pageSize: page.pageSize, total };
  }

  async findNextAfter(userId: string, endsOn: Date, tx?: Prisma.TransactionClient): Promise<PeriodRow | null> {
    const client = tx ?? this.prisma;
    const rows = await client.$queryRaw<RawPeriodRow[]>`
      SELECT id, user_id, starts_on, ends_on, closed_at, deleted_at, created_at, updated_at
      FROM budget_periods
      WHERE user_id = ${userId}::uuid AND deleted_at IS NULL AND starts_on > ${endsOn}::date
      ORDER BY starts_on ASC
      LIMIT 1
    `;
    return rows[0] ? mapPeriodRow(rows[0]) : null;
  }

  async findEarliestOpenBefore(userId: string, startsOn: Date, tx?: Prisma.TransactionClient): Promise<PeriodRow | null> {
    const client = tx ?? this.prisma;
    const rows = await client.$queryRaw<RawPeriodRow[]>`
      SELECT id, user_id, starts_on, ends_on, closed_at, deleted_at, created_at, updated_at
      FROM budget_periods
      WHERE user_id = ${userId}::uuid AND deleted_at IS NULL AND closed_at IS NULL AND starts_on < ${startsOn}::date
      ORDER BY starts_on ASC
      LIMIT 1
    `;
    return rows[0] ? mapPeriodRow(rows[0]) : null;
  }

  async create(userId: string, data: CreatePeriodData): Promise<PeriodRow> {
    try {
      const rows = await this.prisma.$queryRaw<RawPeriodRow[]>`
        INSERT INTO budget_periods (id, user_id, starts_on, ends_on)
        VALUES (gen_random_uuid(), ${userId}::uuid, ${data.startsOn}::date, ${data.endsOn}::date)
        RETURNING id, user_id, starts_on, ends_on, closed_at, deleted_at, created_at, updated_at
      `;
      return mapPeriodRow(rows[0]);
    } catch (e) {
      throw PrismaErrorMapper.toDomainException(e);
    }
  }

  async updateDates(userId: string, id: string, data: UpdatePeriodDatesData): Promise<PeriodRow> {
    const current = await this.findById(userId, id);
    const startsOn = data.startsOn ?? current?.startsOn;
    const endsOn = data.endsOn ?? current?.endsOn;
    try {
      const rows = await this.prisma.$queryRaw<RawPeriodRow[]>`
        UPDATE budget_periods
        SET starts_on = ${startsOn}::date, ends_on = ${endsOn}::date
        WHERE id = ${id}::uuid AND user_id = ${userId}::uuid
        RETURNING id, user_id, starts_on, ends_on, closed_at, deleted_at, created_at, updated_at
      `;
      return mapPeriodRow(rows[0]);
    } catch (e) {
      throw PrismaErrorMapper.toDomainException(e);
    }
  }

  async softDelete(userId: string, id: string): Promise<PeriodRow> {
    const period = await this.prisma.budgetPeriod.update({ where: { id }, data: { deletedAt: new Date() } });
    return period;
  }

  async lockForUpdate(tx: Prisma.TransactionClient, userId: string, id: string): Promise<PeriodRow | null> {
    const rows = await tx.$queryRaw<RawPeriodRow[]>`
      SELECT id, user_id, starts_on, ends_on, closed_at, deleted_at, created_at, updated_at
      FROM budget_periods
      WHERE id = ${id}::uuid AND user_id = ${userId}::uuid AND deleted_at IS NULL
      FOR UPDATE
    `;
    return rows[0] ? mapPeriodRow(rows[0]) : null;
  }

  async setClosedAt(tx: Prisma.TransactionClient, id: string, closedAt: Date): Promise<PeriodRow> {
    const rows = await tx.$queryRaw<RawPeriodRow[]>`
      UPDATE budget_periods SET closed_at = ${closedAt}
      WHERE id = ${id}::uuid
      RETURNING id, user_id, starts_on, ends_on, closed_at, deleted_at, created_at, updated_at
    `;
    return mapPeriodRow(rows[0]);
  }
}
