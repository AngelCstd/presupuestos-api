import type { Prisma } from '@prisma/client';

export interface AllocationRow {
  id: string;
  userId: string;
  periodId: string;
  categoryId: string;
  amountCents: bigint;
  source: 'manual' | 'rollover';
  note: string | null;
  deletedAt: Date | null;
  createdAt: Date;
}

/**
 * Propia de `BudgetModule` — a diferencia de `IBudgetPeriodRepository`
 * (A01b, compartida), nadie más necesita leer/escribir `budget_entries`
 * de asignación manual o rollover (las compensaciones de captura tardía,
 * §2.3, se escriben en `PrismaTransactionRepository`, no aquí — T-R12).
 */
export interface IAllocationRepository {
  create(
    userId: string,
    periodId: string,
    categoryId: string,
    amountCents: bigint,
    source: 'manual' | 'rollover',
    note: string | null,
  ): Promise<AllocationRow>;
  findManyByPeriod(userId: string, periodId: string): Promise<AllocationRow[]>;
  findById(userId: string, id: string): Promise<AllocationRow | null>;
  softDelete(userId: string, id: string): Promise<AllocationRow>;
  countLiveByPeriod(userId: string, periodId: string): Promise<number>;

  /** Dentro de una transacción ya abierta (tras el `FOR UPDATE` del periodo). */
  sumAssignedTx(tx: Prisma.TransactionClient, userId: string, periodId: string, categoryId: string): Promise<bigint>;
  insertTx(
    tx: Prisma.TransactionClient,
    userId: string,
    periodId: string,
    categoryId: string,
    amountCents: bigint,
    source: 'manual' | 'rollover',
    note: string | null,
  ): Promise<AllocationRow>;
}
