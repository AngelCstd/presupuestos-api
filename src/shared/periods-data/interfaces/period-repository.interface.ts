import type { Prisma } from '@prisma/client';
import type { OffsetPage, Paged } from '../../../common/pagination/types';
import type { CreatePeriodData, PeriodRow, UpdatePeriodDatesData } from '../types';

/**
 * TASK-api.md §6.8 — "Métodos mínimos". `A01b`, compartida por A03/A07
 * (compensación de captura tardía, §2.3), A08 (dueño real de la lógica de
 * cierre y asignación) y A09 (`confirm` hereda la misma compensación).
 *
 * `runInTransaction` es la única forma en que un Service orquesta un
 * algoritmo de varios pasos sin importar `PrismaClient` (D1): recibe un
 * `tx` opaco y lo pasa de vuelta a los métodos de este mismo repository
 * que lo aceptan. El repository es quien de verdad llama
 * `prisma.$transaction`.
 */
export interface IBudgetPeriodRepository {
  runInTransaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T>;

  /** Cualquier estado (abierto o cerrado) — usado por `GET /periods/current`. */
  findPeriodCoveringDate(userId: string, date: string, tx?: Prisma.TransactionClient): Promise<PeriodRow | null>;
  /** Solo `closed_at IS NULL` — "el periodo abierto actual" de §2.3, para la compensación de captura tardía. */
  findOpenPeriodCoveringDate(userId: string, date: string, tx?: Prisma.TransactionClient): Promise<PeriodRow | null>;
  findById(userId: string, id: string): Promise<PeriodRow | null>;
  findMany(userId: string, filter: { status?: 'open' | 'closed' }, page: OffsetPage): Promise<Paged<PeriodRow>>;
  findNextAfter(userId: string, endsOn: Date, tx?: Prisma.TransactionClient): Promise<PeriodRow | null>;
  findEarliestOpenBefore(userId: string, startsOn: Date, tx?: Prisma.TransactionClient): Promise<PeriodRow | null>;
  create(userId: string, data: CreatePeriodData): Promise<PeriodRow>;
  updateDates(userId: string, id: string, data: UpdatePeriodDatesData): Promise<PeriodRow>;
  softDelete(userId: string, id: string): Promise<PeriodRow>;

  /** Dentro de una transacción ya abierta — bloquea la fila hasta el COMMIT. */
  lockForUpdate(tx: Prisma.TransactionClient, userId: string, id: string): Promise<PeriodRow | null>;
  setClosedAt(tx: Prisma.TransactionClient, id: string, closedAt: Date): Promise<PeriodRow>;
}
