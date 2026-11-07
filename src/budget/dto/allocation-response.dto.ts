import type { AllocationRow } from '../interfaces/allocation-repository.interface';

export class AllocationResponseDto {
  id!: string;
  periodId!: string;
  categoryId!: string;
  categoryName!: string;
  amountCents!: bigint;
  source!: 'manual' | 'rollover';
  note!: string | null;
  createdAt!: string;

  static from(row: AllocationRow, categoryName: string): AllocationResponseDto {
    const dto = new AllocationResponseDto();
    dto.id = row.id;
    dto.periodId = row.periodId;
    dto.categoryId = row.categoryId;
    dto.categoryName = categoryName;
    dto.amountCents = row.amountCents;
    dto.source = row.source;
    dto.note = row.note;
    dto.createdAt = row.createdAt.toISOString();
    return dto;
  }
}
