import type { AccountRow } from '../../shared/accounts-data/types';
import { TYPE_TO_KIND, type AccountKind } from '../../shared/accounts-data/kind-mapping';

export interface AccountBalanceEntry {
  accountId: string;
  name: string;
  kind: AccountKind;
  currency: string;
  balanceCents: bigint;
}

export class AccountBalancesResponseDto {
  accounts!: AccountBalanceEntry[];

  static from(accounts: AccountRow[], balanceByAccount: Map<string, bigint>): AccountBalancesResponseDto {
    const dto = new AccountBalancesResponseDto();
    dto.accounts = accounts.map((a) => ({
      accountId: a.id,
      name: a.name,
      kind: TYPE_TO_KIND[a.type],
      currency: a.currency,
      balanceCents: balanceByAccount.get(a.id) ?? 0n,
    }));
    return dto;
  }
}
