import type { AccountRow } from '../../shared/accounts-data/types';

export class IncomeSourceResponseDto {
  id!: string;
  name!: string;
  kind = 'income_source' as const;
  currency!: string;
  balanceCents!: bigint;
  archivedAt!: string | null;
  createdAt!: string;
  updatedAt!: string;

  static from(account: AccountRow, balanceCents: bigint): IncomeSourceResponseDto {
    const dto = new IncomeSourceResponseDto();
    dto.id = account.id;
    dto.name = account.name;
    dto.currency = account.currency;
    dto.balanceCents = balanceCents;
    dto.archivedAt = account.archivedAt ? account.archivedAt.toISOString() : null;
    dto.createdAt = account.createdAt.toISOString();
    dto.updatedAt = account.updatedAt.toISOString();
    return dto;
  }
}
