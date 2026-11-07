import type { PeriodRow } from '../../shared/periods-data/types';

export interface CategoryCloseActionDto {
  categoryId: string;
  categoryName: string;
  rolloverType: 'accumulate' | 'reset';
  assignedCents: bigint;
  spentCents: bigint;
  availableCents: bigint;
  hasBudget: boolean;
  action: 'carry_forward' | 'release' | 'carry_deficit' | 'none';
  carryCents: bigint;
}

export class ClosePreviewResponseDto {
  periodId!: string;
  startsOn!: string;
  endsOn!: string;
  nextPeriodId!: string | null;
  canClose!: boolean;
  blockers!: string[];
  categories!: CategoryCloseActionDto[];

  static from(
    period: PeriodRow,
    nextPeriod: PeriodRow | null,
    blockers: string[],
    categories: CategoryCloseActionDto[],
  ): ClosePreviewResponseDto {
    const dto = new ClosePreviewResponseDto();
    dto.periodId = period.id;
    dto.startsOn = period.startsOn.toISOString().slice(0, 10);
    dto.endsOn = period.endsOn.toISOString().slice(0, 10);
    dto.nextPeriodId = nextPeriod?.id ?? null;
    dto.canClose = blockers.length === 0;
    dto.blockers = blockers;
    dto.categories = categories;
    return dto;
  }
}
