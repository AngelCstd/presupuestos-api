import type { OrphanTransactionRow } from '../../shared/queries/types';

export interface UnbudgetedTransactionEntry {
  transactionId: string;
  bookedAt: string;
  description: string;
}

export class UnbudgetedTransactionsResponseDto {
  transactions!: UnbudgetedTransactionEntry[];

  static from(rows: OrphanTransactionRow[]): UnbudgetedTransactionsResponseDto {
    const dto = new UnbudgetedTransactionsResponseDto();
    dto.transactions = rows.map((r) => ({
      transactionId: r.transactionId,
      bookedAt: r.bookedAt.toISOString().slice(0, 10),
      description: r.description,
    }));
    return dto;
  }
}
