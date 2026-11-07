/** TASK-api.md §6.2 — tipos declarados a mano: Prisma no tipa $queryRaw. */
export interface AccountBalanceRow {
  accountId: string;
  name: string;
  type: string;
  currency: string;
  balanceCents: bigint;
}

export interface CategoryBalanceRow {
  categoryId: string;
  name: string;
  assignedCents: bigint;
  spentCents: bigint;
  availableCents: bigint;
  hasBudget: boolean;
}

export interface OrphanTransactionRow {
  transactionId: string;
  bookedAt: Date;
  description: string;
}
