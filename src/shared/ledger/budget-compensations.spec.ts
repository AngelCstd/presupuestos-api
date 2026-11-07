// TASK-api.md §4.9 — función pura, sin I/O. Grupo U (T-U25–U30), unit, sin
// base de datos. Vive junto a `entry-builders.spec.ts` por el mismo motivo:
// `budget-compensations.ts` es su propio archivo puro (§14), separado de
// `entry-builders.ts` — no existe todavía, rojo por diseño.
import { buildBudgetCompensations } from './budget-compensations';

const TX_ID = '9a8b1234-0000-4000-8000-000000000000';
const BOOKED_AT = '2026-08-12';

describe('budget-compensations — buildBudgetCompensations', () => {
  it('T-U25: gasto tardío en una sola categoría → 1 draft con note referenciando tx y fecha', () => {
    const drafts = buildBudgetCompensations({
      entries: [
        { accountId: 'Nu', amountCents: -50000n },
        { accountId: 'Comida', amountCents: 50000n },
      ],
      categoryIds: new Set(['Comida']),
      targetPeriodId: 'P2',
      transactionId: TX_ID,
      bookedAt: BOOKED_AT,
    });

    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ periodId: 'P2', categoryId: 'Comida', amountCents: -50000n });
    expect(drafts[0].note).toContain(TX_ID);
    expect(drafts[0].note).toContain(BOOKED_AT);
  });

  it('T-U26: reversa (signos invertidos) → 1 draft que neutraliza el original, sin caso especial', () => {
    const drafts = buildBudgetCompensations({
      entries: [
        { accountId: 'Nu', amountCents: 50000n },
        { accountId: 'Comida', amountCents: -50000n },
      ],
      categoryIds: new Set(['Comida']),
      targetPeriodId: 'P2',
      transactionId: TX_ID,
      bookedAt: BOOKED_AT,
    });

    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ periodId: 'P2', categoryId: 'Comida', amountCents: 50000n });
  });

  it('T-U27: misma categoría dos veces en entries → UN solo draft, agregado', () => {
    const drafts = buildBudgetCompensations({
      entries: [
        { accountId: 'TDC', amountCents: -70000n },
        { accountId: 'Comida', amountCents: 30000n },
        { accountId: 'Comida', amountCents: 40000n },
      ],
      categoryIds: new Set(['Comida']),
      targetPeriodId: 'P2',
      transactionId: TX_ID,
      bookedAt: BOOKED_AT,
    });

    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ categoryId: 'Comida', amountCents: -70000n });
  });

  it('T-U28: dos categorías distintas afectadas → 2 drafts', () => {
    const drafts = buildBudgetCompensations({
      entries: [
        { accountId: 'TDC', amountCents: -70000n },
        { accountId: 'Comida', amountCents: 30000n },
        { accountId: 'Salud', amountCents: 40000n },
      ],
      categoryIds: new Set(['Comida', 'Salud']),
      targetPeriodId: 'P2',
      transactionId: TX_ID,
      bookedAt: BOOKED_AT,
    });

    expect(drafts).toHaveLength(2);
    expect(drafts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ categoryId: 'Comida', amountCents: -30000n }),
        expect.objectContaining({ categoryId: 'Salud', amountCents: -40000n }),
      ]),
    );
  });

  it('T-U29: entries sin ninguna categoría (transferencia) → [] — no es un error', () => {
    const drafts = buildBudgetCompensations({
      entries: [
        { accountId: 'Nu', amountCents: -70000n },
        { accountId: 'Efectivo', amountCents: 70000n },
      ],
      categoryIds: new Set(['Comida', 'Salud']),
      targetPeriodId: 'P2',
      transactionId: TX_ID,
      bookedAt: BOOKED_AT,
    });

    expect(drafts).toEqual([]);
  });

  it('T-U30: movimientos de una categoría que se cancelan (+500n y −500n) → [] — evita violar budget_entries_amount_nonzero', () => {
    const drafts = buildBudgetCompensations({
      entries: [
        { accountId: 'Comida', amountCents: 500n },
        { accountId: 'Comida', amountCents: -500n },
      ],
      categoryIds: new Set(['Comida']),
      targetPeriodId: 'P2',
      transactionId: TX_ID,
      bookedAt: BOOKED_AT,
    });

    expect(drafts).toEqual([]);
  });
});
