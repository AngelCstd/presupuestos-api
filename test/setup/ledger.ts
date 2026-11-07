import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

interface TransactionParams {
  id?: string;
  userId: string;
  bookedAt: string;
  description?: string;
  idempotencyKey?: string | null;
  reversesTransactionId?: string | null;
}

export async function insertTransaction(client: PoolClient, params: TransactionParams): Promise<string> {
  const id = params.id ?? randomUUID();
  await client.query(
    `INSERT INTO transactions (id, user_id, booked_at, description, idempotency_key, reverses_transaction_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      id,
      params.userId,
      params.bookedAt,
      params.description ?? 'test',
      params.idempotencyKey ?? null,
      params.reversesTransactionId ?? null,
    ],
  );
  return id;
}

interface EntryParams {
  id?: string;
  transactionId: string;
  userId: string;
  accountId: string;
  amountCents: number;
}

export async function insertEntry(client: PoolClient, params: EntryParams): Promise<string> {
  const id = params.id ?? randomUUID();
  await client.query(
    `INSERT INTO entries (id, transaction_id, user_id, account_id, amount_cents)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, params.transactionId, params.userId, params.accountId, params.amountCents],
  );
  return id;
}

/** Inserta una transacción balanceada con N entries en una sola llamada. */
export async function insertBalancedTransaction(
  client: PoolClient,
  params: {
    userId: string;
    bookedAt: string;
    entries: Array<{ accountId: string; amountCents: number }>;
    description?: string;
    idempotencyKey?: string | null;
    reversesTransactionId?: string | null;
  },
): Promise<{ transactionId: string; entryIds: string[] }> {
  const transactionId = await insertTransaction(client, params);
  const entryIds: string[] = [];
  for (const entry of params.entries) {
    entryIds.push(
      await insertEntry(client, {
        transactionId,
        userId: params.userId,
        accountId: entry.accountId,
        amountCents: entry.amountCents,
      }),
    );
  }
  return { transactionId, entryIds };
}

interface BudgetEntryParams {
  id?: string;
  userId: string;
  periodId: string;
  categoryId: string;
  amountCents: number;
  source?: 'manual' | 'rollover';
  note?: string | null;
}

export async function insertBudgetEntry(client: PoolClient, params: BudgetEntryParams): Promise<string> {
  const id = params.id ?? randomUUID();
  await client.query(
    `INSERT INTO budget_entries (id, user_id, period_id, category_id, amount_cents, source, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      id,
      params.userId,
      params.periodId,
      params.categoryId,
      params.amountCents,
      params.source ?? 'manual',
      params.note ?? null,
    ],
  );
  return id;
}
