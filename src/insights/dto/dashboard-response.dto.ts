import type { PeriodRow } from '../../shared/periods-data/types';
import type { AccountBalanceEntry } from './account-balances-response.dto';
import type { CategoryBalanceEntry } from './category-balances-response.dto';
import type { UnbudgetedTransactionEntry } from './unbudgeted-transactions-response.dto';

export interface DashboardPeriodEntry {
  id: string;
  startsOn: string;
  endsOn: string;
  status: 'open' | 'closed';
  closedAt: string | null;
}

export class DashboardResponseDto {
  accounts!: AccountBalanceEntry[];
  unassignedCents!: bigint;
  period!: DashboardPeriodEntry | null;
  categories!: CategoryBalanceEntry[];
  unbudgetedTransactions!: UnbudgetedTransactionEntry[];

  static from(
    accounts: AccountBalanceEntry[],
    unassignedCents: bigint,
    period: PeriodRow | null,
    categories: CategoryBalanceEntry[],
    unbudgetedTransactions: UnbudgetedTransactionEntry[],
  ): DashboardResponseDto {
    const dto = new DashboardResponseDto();
    dto.accounts = accounts;
    dto.unassignedCents = unassignedCents;
    dto.period = period
      ? {
          id: period.id,
          startsOn: period.startsOn.toISOString().slice(0, 10),
          endsOn: period.endsOn.toISOString().slice(0, 10),
          status: period.closedAt ? 'closed' : 'open',
          closedAt: period.closedAt ? period.closedAt.toISOString() : null,
        }
      : null;
    dto.categories = categories;
    dto.unbudgetedTransactions = unbudgetedTransactions;
    return dto;
  }
}
