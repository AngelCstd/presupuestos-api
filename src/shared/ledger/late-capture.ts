import type { Prisma } from '@prisma/client';
import type { IBudgetPeriodRepository } from '../periods-data/interfaces/period-repository.interface';
import type { EntryDraft } from './entry-builders';
import { buildBudgetCompensations, type BudgetCompensationDraft } from './budget-compensations';

export interface BudgetImpact {
  status: 'in_open_period' | 'no_period' | 'compensated' | 'uncompensated';
  closedPeriodId: string | null;
  compensatedInPeriodId: string | null;
  compensations: BudgetCompensationDraft[];
}

export interface LateCaptureResolution {
  budgetImpact: BudgetImpact;
  compensations: BudgetCompensationDraft[];
}

const NO_IMPACT: Omit<BudgetImpact, 'status'> = { closedPeriodId: null, compensatedInPeriodId: null, compensations: [] };

/**
 * TASK-api.md §2.3 — compensación presupuestal de captura tardía.
 * Compartida por `TransactionsService` (A07) y `RecurringService` (A09,
 * `confirm`) para que ninguno reimplemente la regla ni importe al otro
 * (D4) — vive en `shared/ledger`, junto a `buildBudgetCompensations`.
 *
 * Regla de disparo (§2.3): se evalúa para TODO movimiento contra una
 * categoría, no una lista de endpoints — por eso basta con pasar
 * `categoryIds` vacío para que un movimiento que no toca sobres (income,
 * transfer, loan, loan-repayment) nunca compense, sin caso especial.
 */
export async function resolveLateCaptureCompensation(
  periodRepository: IBudgetPeriodRepository,
  params: {
    userId: string;
    bookedAt: string;
    today: string;
    entries: EntryDraft[];
    categoryIds: Set<string>;
    transactionId: string;
  },
  tx?: Prisma.TransactionClient,
): Promise<LateCaptureResolution> {
  const coveringPeriod = await periodRepository.findPeriodCoveringDate(params.userId, params.bookedAt, tx);

  if (!coveringPeriod) {
    return { budgetImpact: { status: 'no_period', ...NO_IMPACT }, compensations: [] };
  }

  if (coveringPeriod.closedAt === null) {
    return { budgetImpact: { status: 'in_open_period', ...NO_IMPACT }, compensations: [] };
  }

  const openPeriod = await periodRepository.findOpenPeriodCoveringDate(params.userId, params.today, tx);

  if (!openPeriod) {
    return {
      budgetImpact: { status: 'uncompensated', closedPeriodId: coveringPeriod.id, compensatedInPeriodId: null, compensations: [] },
      compensations: [],
    };
  }

  const compensations = buildBudgetCompensations({
    entries: params.entries,
    categoryIds: params.categoryIds,
    targetPeriodId: openPeriod.id,
    transactionId: params.transactionId,
    bookedAt: params.bookedAt,
  });

  return {
    budgetImpact: {
      status: 'compensated',
      closedPeriodId: coveringPeriod.id,
      compensatedInPeriodId: openPeriod.id,
      compensations,
    },
    compensations,
  };
}

/**
 * §4.8, "Fecha bloqueada en reversas compensadas" — true si el
 * `bookedAt` original cae en un periodo cerrado (es decir, si generó
 * compensatorio). Se deriva del mismo cálculo que el Service ya hace
 * para decidir si compensa, sin columna ni consulta adicional.
 */
export async function originalGeneratedCompensation(
  periodRepository: IBudgetPeriodRepository,
  userId: string,
  originalBookedAt: string,
): Promise<boolean> {
  const coveringPeriod = await periodRepository.findPeriodCoveringDate(userId, originalBookedAt);
  return coveringPeriod !== null && coveringPeriod.closedAt !== null;
}
