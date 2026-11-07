import type { AccountType } from '@prisma/client';
import type { IAccountRepository } from '../accounts-data/interfaces/account-repository.interface';
import type { AccountRow } from '../accounts-data/types';
import { AccountNotFoundException } from '../accounts-data/exceptions/account-not-found.exception';
import { SystemAccountException } from '../../transactions/exceptions/system-account.exception';
import { ArchivedAccountException } from '../../transactions/exceptions/archived-account.exception';
import { InvalidAccountRoleException } from '../../transactions/exceptions/invalid-account-role.exception';
import { MixedCurrencyException } from '../../transactions/exceptions/mixed-currency.exception';

export interface AccountRoleSpec {
  id: string;
  allowedTypes: AccountType[];
}

/**
 * TASK-api.md §6.7, pasos 2-7 — un solo `findManyByIds`, luego
 * existencia/propiedad (404) → `is_system` (403) → archivada (409, S-R9)
 * → rol (422) → moneda única (422), en ese orden por cuenta. Compartida
 * por `TransactionsService` (A07) y `RecurringService` (A09, `confirm`)
 * para que ninguno reimplemente la secuencia ni importe al otro (D4).
 */
export async function validateAndLoadAccounts(
  accountRepository: IAccountRepository,
  userId: string,
  specs: AccountRoleSpec[],
): Promise<Map<string, AccountRow>> {
  const uniqueIds = [...new Set(specs.map((s) => s.id))];
  const accounts = await accountRepository.findManyByIds(userId, uniqueIds);
  const byId = new Map(accounts.map((a) => [a.id, a]));

  for (const spec of specs) {
    const account = byId.get(spec.id);
    if (!account) {
      throw new AccountNotFoundException();
    }
    if (account.isSystem) {
      throw new SystemAccountException();
    }
    if (account.archivedAt !== null) {
      throw new ArchivedAccountException();
    }
    if (!spec.allowedTypes.includes(account.type)) {
      throw new InvalidAccountRoleException();
    }
  }

  const currencies = new Set(specs.map((s) => byId.get(s.id)!.currency));
  if (currencies.size > 1) {
    throw new MixedCurrencyException();
  }

  return byId;
}
