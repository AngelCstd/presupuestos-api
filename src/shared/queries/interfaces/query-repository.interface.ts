import type { AccountBalanceRow, CategoryBalanceRow, OrphanTransactionRow } from '../types';

export interface IQueryRepository {
  accountBalances(userId: string): Promise<AccountBalanceRow[]>;
  categoryBalances(userId: string, periodId: string): Promise<CategoryBalanceRow[]>;
  unassignedFunds(userId: string): Promise<bigint>;
  transactionsWithoutPeriod(userId: string): Promise<OrphanTransactionRow[]>;
}
