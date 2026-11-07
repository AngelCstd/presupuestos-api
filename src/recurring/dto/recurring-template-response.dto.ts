import type { RecurringTemplateRow } from '../interfaces/recurring-template-repository.interface';

export class RecurringTemplateResponseDto {
  id!: string;
  name!: string;
  categoryId!: string;
  categoryName!: string;
  accountId!: string | null;
  accountName!: string | null;
  amountCents!: bigint;
  dayOfMonth!: number;
  nextDueOn!: string;
  lastConfirmedOn!: string | null;
  isActive!: boolean;
  isDue!: boolean;
  createdAt!: string;
  updatedAt!: string;

  static from(row: RecurringTemplateRow, categoryName: string, accountName: string | null, today: string): RecurringTemplateResponseDto {
    const dto = new RecurringTemplateResponseDto();
    dto.id = row.id;
    dto.name = row.name;
    dto.categoryId = row.categoryId;
    dto.categoryName = categoryName;
    dto.accountId = row.accountId;
    dto.accountName = accountName;
    dto.amountCents = row.amountCents;
    dto.dayOfMonth = row.dayOfMonth;
    dto.nextDueOn = row.nextDueOn.toISOString().slice(0, 10);
    dto.lastConfirmedOn = row.lastConfirmedOn ? row.lastConfirmedOn.toISOString().slice(0, 10) : null;
    dto.isActive = row.isActive;
    dto.isDue = dto.nextDueOn <= today;
    dto.createdAt = row.createdAt.toISOString();
    dto.updatedAt = row.updatedAt.toISOString();
    return dto;
  }
}
