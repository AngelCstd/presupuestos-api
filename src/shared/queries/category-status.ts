import type { CategoryBalanceRow } from './types';

export type CategoryStatus = 'no_budget' | 'available' | 'depleted' | 'overspent';

/**
 * API-CONTRACT.md §10.1 — se deriva del CONTEO de asignaciones
 * (`hasBudget`), no del monto: dos asignaciones que se cancelan dejan
 * `assignedCents: "0"` con `hasBudget: true`. Compartida por
 * `CategoriesModule`, `BudgetModule` (close-preview, `PUT
 * .../allocations/{categoryId}`) e `InsightsModule`
 * (`category-balances`) — la misma regla, un solo lugar (D4).
 */
export function deriveCategoryStatus(row: Pick<CategoryBalanceRow, 'hasBudget' | 'availableCents'>): CategoryStatus {
  if (!row.hasBudget) return 'no_budget';
  if (row.availableCents > 0n) return 'available';
  if (row.availableCents === 0n) return 'depleted';
  return 'overspent';
}
