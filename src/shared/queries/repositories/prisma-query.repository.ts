import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import type { IQueryRepository } from '../interfaces/query-repository.interface';
import type { AccountBalanceRow, CategoryBalanceRow, OrphanTransactionRow } from '../types';

interface RawAccountBalanceRow {
  account_id: string;
  name: string;
  type: string;
  currency: string;
  balance_cents: bigint;
}

interface RawCategoryBalanceRow {
  category_id: string;
  name: string;
  assigned_cents: bigint;
  spent_cents: bigint;
  available_cents: bigint;
  has_budget: boolean;
}

interface RawOrphanTransactionRow {
  transaction_id: string;
  booked_at: Date;
  description: string;
}

/**
 * TASK-api.md §6.2 — envuelve F1-F4 vía $queryRaw tipado. Ninguna de las
 * cuatro recibe parámetros de filtrado adicionales, ni filtra
 * `archived_at` por su cuenta (S-R4) — eso es responsabilidad exclusiva
 * del Service consumidor cuando aplica.
 */
@Injectable()
export class PrismaQueryRepository implements IQueryRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async accountBalances(userId: string): Promise<AccountBalanceRow[]> {
    const rows = await this.prisma.$queryRaw<RawAccountBalanceRow[]>`
      SELECT account_id, name, type, currency, balance_cents FROM fn_account_balances(${userId}::uuid)
    `;
    return rows.map((r) => ({
      accountId: r.account_id,
      name: r.name,
      type: r.type,
      currency: r.currency,
      balanceCents: r.balance_cents,
    }));
  }

  async categoryBalances(userId: string, periodId: string): Promise<CategoryBalanceRow[]> {
    const rows = await this.prisma.$queryRaw<RawCategoryBalanceRow[]>`
      SELECT category_id, name, assigned_cents, spent_cents, available_cents, has_budget
      FROM fn_category_balances(${userId}::uuid, ${periodId}::uuid)
    `;
    return rows.map((r) => ({
      categoryId: r.category_id,
      name: r.name,
      assignedCents: r.assigned_cents,
      spentCents: r.spent_cents,
      availableCents: r.available_cents,
      hasBudget: r.has_budget,
    }));
  }

  // F3 garantiza exactamente una fila siempre — se desempaqueta a bigint,
  // nunca se devuelve como arreglo.
  async unassignedFunds(userId: string): Promise<bigint> {
    const rows = await this.prisma.$queryRaw<Array<{ unassigned_cents: bigint }>>`
      SELECT unassigned_cents FROM fn_unassigned_funds(${userId}::uuid)
    `;
    return rows[0].unassigned_cents;
  }

  async transactionsWithoutPeriod(userId: string): Promise<OrphanTransactionRow[]> {
    const rows = await this.prisma.$queryRaw<RawOrphanTransactionRow[]>`
      SELECT transaction_id, booked_at, description FROM fn_transactions_without_period(${userId}::uuid)
    `;
    return rows.map((r) => ({ transactionId: r.transaction_id, bookedAt: r.booked_at, description: r.description }));
  }
}
