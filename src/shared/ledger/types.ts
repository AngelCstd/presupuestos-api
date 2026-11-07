import type { EntryDraft } from './entry-builders';
import type { BudgetCompensationDraft } from './budget-compensations';

export interface TransactionDraft {
  id: string;
  bookedAt: Date;
  description: string;
  idempotencyKey?: string | null;
  reversesTransactionId?: string | null;
}

export interface TransactionRow {
  id: string;
  userId: string;
  bookedAt: Date;
  description: string;
  idempotencyKey: string | null;
  reversesTransactionId: string | null;
  createdAt: Date;
}

export interface EntryRow {
  id: string;
  transactionId: string;
  userId: string;
  accountId: string;
  amountCents: bigint;
  createdAt: Date;
}

export interface TransactionWithEntries extends TransactionRow {
  entries: EntryRow[];
}

export interface CreateTransactionResult {
  transaction: TransactionRow;
  entries: EntryRow[];
  created: boolean;
}

export interface TxCursor {
  b: string;
  t: string;
}

export interface EntryCursor {
  b: string;
  t: string;
  e: string;
}

export interface CursorPage<T> {
  data: T[];
  nextCursor: string | null;
}

export interface TransactionFilter {
  from?: string;
  to?: string;
  accountId?: string;
  categoryId?: string;
}

export interface EntryWithTransaction {
  transactionId: string;
  bookedAt: Date;
  description: string;
  amountCents: bigint;
  createdAt: Date;
}

export type { EntryDraft, BudgetCompensationDraft };
