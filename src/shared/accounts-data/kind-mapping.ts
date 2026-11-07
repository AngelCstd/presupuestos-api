import { AccountType } from '@prisma/client';

/** TASK-api.md §5.6 — vocabulario de cara al cliente, nunca partida doble. */
export type AccountKind = 'cash' | 'credit' | 'receivable' | 'category' | 'income_source' | 'system';

export const TYPE_TO_KIND: Record<AccountType, AccountKind> = {
  [AccountType.Asset]: 'cash',
  [AccountType.Liability]: 'credit',
  [AccountType.Receivable]: 'receivable',
  [AccountType.Expense]: 'category',
  [AccountType.Income]: 'income_source',
  [AccountType.Equity]: 'system',
};

export const KIND_TO_TYPE: Record<AccountKind, AccountType> = {
  cash: AccountType.Asset,
  credit: AccountType.Liability,
  receivable: AccountType.Receivable,
  category: AccountType.Expense,
  income_source: AccountType.Income,
  system: AccountType.Equity,
};
