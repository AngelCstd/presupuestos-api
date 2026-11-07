import { TYPE_TO_KIND, type AccountKind } from '../../shared/accounts-data/kind-mapping';
import type { AccountRow } from '../../shared/accounts-data/types';
import type { EntryRow, TransactionRow } from '../../shared/ledger/types';

export class MovementDto {
  accountId!: string;
  accountName!: string;
  accountKind!: AccountKind;
  amountCents!: bigint;
}

/**
 * TASK-api.md §5.6 — `GET /transactions/{id}` y `GET /transactions`
 * devuelven `movements`, la vista legible de lo que se movió. Nunca en
 * la respuesta de creación (T-R11). La cuenta ancla interna de un saldo
 * inicial se omite del arreglo (§6.7): nunca se expone al cliente.
 */
export class TransactionDetailResponseDto {
  id!: string;
  bookedAt!: string;
  description!: string;
  totalCents!: bigint;
  reversesTransactionId!: string | null;
  reversedByTransactionId!: string | null;
  createdAt!: string;
  movements!: MovementDto[];

  static from(
    transaction: TransactionRow,
    rows: EntryRow[],
    accountsById: Map<string, AccountRow>,
    reversedByTransactionId: string | null,
  ): TransactionDetailResponseDto {
    const dto = new TransactionDetailResponseDto();
    dto.id = transaction.id;
    dto.bookedAt = transaction.bookedAt.toISOString().slice(0, 10);
    dto.description = transaction.description;
    dto.reversesTransactionId = transaction.reversesTransactionId;
    dto.reversedByTransactionId = reversedByTransactionId;
    dto.createdAt = transaction.createdAt.toISOString();

    dto.movements = rows
      .filter((row: EntryRow) => {
        const account = accountsById.get(row.accountId);
        return account !== undefined && !account.isSystem;
      })
      // §6.7 — orden garantizado: primero de dónde salió el dinero
      // (montos negativos), luego a dónde fue (positivos). Desempate por
      // `id` para que un split simétrico (montos iguales) siga siendo
      // estable entre lecturas.
      .sort((a: EntryRow, b: EntryRow) => (a.amountCents < b.amountCents ? -1 : a.amountCents > b.amountCents ? 1 : a.id < b.id ? -1 : 1))
      .map((row: EntryRow) => {
        const account = accountsById.get(row.accountId)!;
        return {
          accountId: account.id,
          accountName: account.name,
          accountKind: TYPE_TO_KIND[account.type],
          amountCents: row.amountCents,
        };
      });

    dto.totalCents = dto.movements
      .filter((m) => m.amountCents > 0n)
      .reduce((acc, m) => acc + m.amountCents, 0n);

    return dto;
  }
}
