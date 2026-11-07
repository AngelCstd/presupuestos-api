import { Injectable } from '@nestjs/common';
import { AccountType, Prisma, PrismaClient } from '@prisma/client';
import type { IAccountRepository } from '../interfaces/account-repository.interface';
import type { AccountRow, CreateAccountData, UpdateAccountData } from '../types';
import type { OffsetPage, Paged } from '../../../common/pagination/types';

/**
 * Sin `@relation` en schema.prisma (decisión de TASK-db: el patrón
 * Repository filtra por `user_id` explícito, no por includes
 * relacionales) — `hasLiveAllocationsInOpenPeriods` usa `$queryRaw` con
 * JOIN en vez de un filtro anidado de Prisma.
 */
@Injectable()
export class PrismaAccountRepository implements IAccountRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(userId: string, data: CreateAccountData): Promise<AccountRow> {
    return this.prisma.account.create({
      data: {
        userId,
        name: data.name,
        type: data.type,
        currency: data.currency,
        rolloverType: data.rolloverType ?? null,
        isSystem: data.isSystem ?? false,
      },
    });
  }

  async findById(userId: string, id: string): Promise<AccountRow | null> {
    return this.prisma.account.findFirst({ where: { id, userId } });
  }

  async findManyByIds(userId: string, ids: string[]): Promise<AccountRow[]> {
    if (ids.length === 0) return [];
    return this.prisma.account.findMany({ where: { userId, id: { in: ids } } });
  }

  // S-R4: es el ÚNICO método que filtra `archived_at` — nunca en cálculos.
  async findMany(
    userId: string,
    filter: { types: AccountType[]; includeArchived: boolean; includeSystem: boolean },
    page: OffsetPage,
  ): Promise<Paged<AccountRow>> {
    const where: Prisma.AccountWhereInput = {
      userId,
      ...(filter.types.length > 0 ? { type: { in: filter.types } } : {}),
      ...(filter.includeArchived ? {} : { archivedAt: null }),
      ...(filter.includeSystem ? {} : { isSystem: false }),
    };

    const [data, total] = await Promise.all([
      this.prisma.account.findMany({
        where,
        skip: (page.page - 1) * page.pageSize,
        take: page.pageSize,
        // Orden garantizado de la API (TASK-api.md §6.5/§6.6): `name`
        // ascendente, `id` ascendente de desempate — no `createdAt`.
        // `createdAt` no es único (varias cuentas creadas en la misma
        // transacción, típico en seeds/fixtures, comparten el mismo
        // `now()` de Postgres) y da un orden indefinido entre ellas. Un
        // cliente que pinta la lista de cuentas/categorías necesita que
        // no baile entre cargas — misma razón que el orden de
        // `movements` en `TransactionDetailResponseDto`.
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
      }),
      this.prisma.account.count({ where }),
    ]);

    return { data, page: page.page, pageSize: page.pageSize, total };
  }

  async findSystemEquity(userId: string): Promise<AccountRow | null> {
    return this.prisma.account.findFirst({ where: { userId, type: AccountType.Equity, isSystem: true } });
  }

  async update(userId: string, id: string, data: UpdateAccountData): Promise<AccountRow> {
    return this.prisma.account.update({
      where: { id },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.currency !== undefined ? { currency: data.currency } : {}),
        ...(data.rolloverType !== undefined ? { rolloverType: data.rolloverType } : {}),
      },
    });
  }

  async setArchivedAt(userId: string, id: string, value: Date | null): Promise<AccountRow> {
    return this.prisma.account.update({ where: { id }, data: { archivedAt: value } });
  }

  async hasEntries(userId: string, accountId: string): Promise<boolean> {
    const count = await this.prisma.entry.count({ where: { userId, accountId } });
    return count > 0;
  }

  async hasLiveAllocationsInOpenPeriods(userId: string, categoryId: string): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<Array<{ exists: boolean }>>`
      SELECT EXISTS(
        SELECT 1
        FROM budget_entries be
        JOIN budget_periods bp ON bp.id = be.period_id
        WHERE be.user_id = ${userId}::uuid
          AND be.category_id = ${categoryId}::uuid
          AND be.deleted_at IS NULL
          AND bp.closed_at IS NULL
          AND bp.deleted_at IS NULL
      ) AS exists
    `;
    return rows[0]?.exists ?? false;
  }

  async nameExists(userId: string, name: string, excludeId?: string): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<Array<{ exists: boolean }>>`
      SELECT EXISTS(
        SELECT 1 FROM accounts
        WHERE user_id = ${userId}::uuid
          AND lower(name) = lower(${name})
          AND archived_at IS NULL
          AND id != COALESCE(${excludeId ?? null}::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
      ) AS exists
    `;
    return rows[0]?.exists ?? false;
  }
}
