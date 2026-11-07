import type { AccountRow } from '../../shared/accounts-data/types';
import type { CategoryBalanceRow } from '../../shared/queries/types';
import { deriveCategoryStatus } from '../../shared/queries/category-status';

export interface CategoryPeriodBlock {
  periodId: string;
  assignedCents: bigint;
  spentCents: bigint;
  availableCents: bigint;
  hasBudget: boolean;
  status: 'no_budget' | 'available' | 'depleted' | 'overspent';
}

export class CategoryResponseDto {
  id!: string;
  name!: string;
  kind = 'category' as const;
  rolloverType!: 'accumulate' | 'reset';
  currency!: string;
  balanceCents!: bigint;
  archivedAt!: string | null;
  createdAt!: string;
  updatedAt!: string;
  period!: CategoryPeriodBlock | null;

  static from(account: AccountRow, balanceCents: bigint, periodId?: string, balanceRow?: CategoryBalanceRow): CategoryResponseDto {
    const dto = new CategoryResponseDto();
    dto.id = account.id;
    dto.name = account.name;
    dto.rolloverType = account.rolloverType === 'Accumulate' ? 'accumulate' : 'reset';
    dto.currency = account.currency;
    dto.balanceCents = balanceCents;
    dto.archivedAt = account.archivedAt ? account.archivedAt.toISOString() : null;
    dto.createdAt = account.createdAt.toISOString();
    dto.updatedAt = account.updatedAt.toISOString();
    dto.period = periodId && balanceRow ? CategoryResponseDto.periodBlock(periodId, balanceRow) : null;
    return dto;
  }

  private static periodBlock(periodId: string, row: CategoryBalanceRow): CategoryPeriodBlock {
    return {
      periodId,
      assignedCents: row.assignedCents,
      spentCents: row.spentCents,
      availableCents: row.availableCents,
      hasBudget: row.hasBudget,
      status: deriveCategoryStatus(row),
    };
  }
}
