import type { EntryDraft } from './entry-builders';

/** TASK-api.md §4.9 — compensación presupuestal de captura tardía (§2.3). */
export interface BudgetCompensationDraft {
  periodId: string;
  categoryId: string;
  amountCents: bigint;
  note: string;
}

export function buildBudgetCompensations(input: {
  entries: EntryDraft[];
  categoryIds: Set<string>;
  targetPeriodId: string;
  transactionId: string;
  bookedAt: string;
}): BudgetCompensationDraft[] {
  const sumsByCategory = new Map<string, bigint>();

  for (const entry of input.entries) {
    if (!input.categoryIds.has(entry.accountId)) continue;
    sumsByCategory.set(entry.accountId, (sumsByCategory.get(entry.accountId) ?? 0n) + entry.amountCents);
  }

  const note = `Ajuste por captura tardía — tx ${input.transactionId}, fecha ${input.bookedAt}`;

  const drafts: BudgetCompensationDraft[] = [];
  for (const [categoryId, sum] of sumsByCategory) {
    if (sum === 0n) continue;
    drafts.push({ periodId: input.targetPeriodId, categoryId, amountCents: -sum, note });
  }
  return drafts;
}
