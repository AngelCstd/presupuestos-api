import type { CategoryBalanceRow } from '../../shared/queries/types';
import { deriveCategoryStatus, type CategoryStatus } from '../../shared/queries/category-status';

export interface CategoryBalanceEntry {
  categoryId: string;
  name: string;
  assignedCents: bigint;
  spentCents: bigint;
  availableCents: bigint;
  hasBudget: boolean;
  status: CategoryStatus;
}

export class CategoryBalancesResponseDto {
  periodId!: string;
  categories!: CategoryBalanceEntry[];

  static from(periodId: string, rows: CategoryBalanceRow[]): CategoryBalancesResponseDto {
    const dto = new CategoryBalancesResponseDto();
    dto.periodId = periodId;
    dto.categories = rows.map((r) => ({
      categoryId: r.categoryId,
      name: r.name,
      assignedCents: r.assignedCents,
      spentCents: r.spentCents,
      availableCents: r.availableCents,
      hasBudget: r.hasBudget,
      status: deriveCategoryStatus(r),
    }));
    return dto;
  }
}
