import type { EntryDraft } from '../entry-builders';
import type { BudgetCompensationDraft } from '../budget-compensations';
import type {
  CreateTransactionResult,
  CursorPage,
  EntryCursor,
  EntryWithTransaction,
  TransactionDraft,
  TransactionFilter,
  TransactionRow,
  TransactionWithEntries,
  TxCursor,
} from '../types';

export interface ITransactionRepository {
  createWithEntries(
    userId: string,
    draft: TransactionDraft,
    entries: EntryDraft[],
    compensations?: BudgetCompensationDraft[],
  ): Promise<CreateTransactionResult>;
  findById(userId: string, id: string): Promise<TransactionWithEntries | null>;
  findByIdempotencyKey(userId: string, key: string): Promise<TransactionWithEntries | null>;
  findReversalOf(userId: string, transactionId: string): Promise<TransactionRow | null>;
  updateDescription(userId: string, id: string, description: string): Promise<TransactionRow>;
  findManyByCursor(
    userId: string,
    filter: TransactionFilter,
    cursor: TxCursor | null,
    limit: number,
  ): Promise<CursorPage<TransactionWithEntries>>;
  findEntriesByAccountCursor(
    userId: string,
    accountId: string,
    cursor: EntryCursor | null,
    limit: number,
  ): Promise<CursorPage<EntryWithTransaction>>;
}
