import type { CategoryBalanceRow } from '../../shared/queries/types';
import { deriveCategoryStatus } from '../../shared/queries/category-status';

export class AllocationSetResponseDto {
  periodId!: string;
  categoryId!: string;
  assignedCents!: bigint;
  spentCents!: bigint;
  availableCents!: bigint;
  hasBudget!: boolean;
  status!: 'no_budget' | 'available' | 'depleted' | 'overspent';

  static from(periodId: string, row: CategoryBalanceRow): AllocationSetResponseDto {
    const dto = new AllocationSetResponseDto();
    dto.periodId = periodId;
    dto.categoryId = row.categoryId;
    dto.assignedCents = row.assignedCents;
    dto.spentCents = row.spentCents;
    dto.availableCents = row.availableCents;
    dto.hasBudget = row.hasBudget;
    dto.status = deriveCategoryStatus(row);
    return dto;
  }
}
