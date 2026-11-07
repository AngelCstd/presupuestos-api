import { nextDueOn } from '../../src/shared/recurrence/next-due-on';

function utc(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

function isoOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

describe('Grupo I — nextDueOn (U08b, función pura, sin DB)', () => {
  it('T-I01: day=15, confirmado 2026-01-15 → 2026-02-15', () => {
    expect(isoOf(nextDueOn(15, utc('2026-01-15')))).toBe('2026-02-15');
  });

  it('T-I02: day=31, confirmado 2026-01-31 (año no bisiesto) → 2026-03-01', () => {
    expect(isoOf(nextDueOn(31, utc('2026-01-31')))).toBe('2026-03-01');
  });

  it('T-I03: day=31, confirmado 2024-01-31 (año bisiesto) → 2024-03-01', () => {
    expect(isoOf(nextDueOn(31, utc('2024-01-31')))).toBe('2024-03-01');
  });

  it('T-I04: day=30, confirmado 2026-01-30 → 2026-03-01', () => {
    expect(isoOf(nextDueOn(30, utc('2026-01-30')))).toBe('2026-03-01');
  });

  it('T-I05: day=31, confirmado 2026-03-31 → 2026-05-01 (abril no tiene 31)', () => {
    expect(isoOf(nextDueOn(31, utc('2026-03-31')))).toBe('2026-05-01');
  });

  it('T-I06: sin corrimiento acumulado — dos confirmaciones sucesivas', () => {
    const first = nextDueOn(31, utc('2026-01-31'));
    expect(isoOf(first)).toBe('2026-03-01');

    // La segunda confirmación parte de day_of_month=31 aplicado al mes
    // siguiente a la NUEVA fecha confirmada (2026-03-01), no de
    // `first + 1 mes`. Si arrastrara el corrimiento, daría 2026-04-01.
    const second = nextDueOn(31, utc('2026-03-01'));
    expect(isoOf(second)).toBe('2026-03-31');
  });
});
