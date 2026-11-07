import type { AccountRow } from '../../shared/accounts-data/types';
import { TYPE_TO_KIND, type AccountKind } from '../../shared/accounts-data/kind-mapping';

export class AccountResponseDto {
  id!: string;
  name!: string;
  kind!: AccountKind;
  currency!: string;
  balanceCents!: bigint;
  archivedAt!: string | null;
  createdAt!: string;
  updatedAt!: string;

  static from(account: AccountRow, balanceCents: bigint): AccountResponseDto {
    const dto = new AccountResponseDto();
    dto.id = account.id;
    dto.name = account.name;
    dto.kind = TYPE_TO_KIND[account.type];
    dto.currency = account.currency;
    dto.balanceCents = balanceCents;
    dto.archivedAt = account.archivedAt ? account.archivedAt.toISOString() : null;
    dto.createdAt = account.createdAt.toISOString();
    dto.updatedAt = account.updatedAt.toISOString();
    return dto;
  }
}
