import type { BudgetImpact } from '../late-capture';
import type { TransactionRow } from '../types';

export class BudgetImpactDto {
  status!: BudgetImpact['status'];
  closedPeriodId!: string | null;
  compensatedInPeriodId!: string | null;
  compensations!: Array<{ categoryId: string; categoryName: string; amountCents: bigint }>;

  static from(impact: BudgetImpact, categoryNames: Map<string, string>): BudgetImpactDto {
    const dto = new BudgetImpactDto();
    dto.status = impact.status;
    dto.closedPeriodId = impact.closedPeriodId;
    dto.compensatedInPeriodId = impact.compensatedInPeriodId;
    dto.compensations = impact.compensations.map((c) => ({
      categoryId: c.categoryId,
      categoryName: categoryNames.get(c.categoryId) ?? '',
      amountCents: c.amountCents,
    }));
    return dto;
  }
}

/**
 * TASK-api.md §6.7/§6.9 — la respuesta de CREACIÓN de cualquier
 * `/transactions/*` y de `POST /recurring-templates/{id}/confirm`
 * (dentro de `transaction`, §6.9). Vive en `shared/ledger`, no en
 * `transactions/`: `RecurringModule` la necesita con la forma idéntica y
 * no puede importar el módulo de dominio de otro (D4). Nunca incluye
 * `movements` (T-R11): eso solo viaja en `GET /transactions/{id}` y en
 * el listado.
 */
export class TransactionResponseDto {
  id!: string;
  bookedAt!: string;
  description!: string;
  totalCents!: bigint;
  reversesTransactionId!: string | null;
  createdAt!: string;
  budgetImpact!: BudgetImpactDto;

  static from(transaction: TransactionRow, totalCents: bigint, budgetImpact: BudgetImpactDto): TransactionResponseDto {
    const dto = new TransactionResponseDto();
    dto.id = transaction.id;
    dto.bookedAt = transaction.bookedAt.toISOString().slice(0, 10);
    dto.description = transaction.description;
    dto.totalCents = totalCents;
    dto.reversesTransactionId = transaction.reversesTransactionId;
    dto.createdAt = transaction.createdAt.toISOString();
    dto.budgetImpact = budgetImpact;
    return dto;
  }
}
