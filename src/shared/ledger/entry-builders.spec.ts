// TASK-api.md §4 — funciones puras, sin I/O. Grupo U (T-U01–U16), unit,
// sin base de datos. `src/shared/ledger/entry-builders.ts` no existe
// todavía — falla en rojo por diseño hasta que el loop de implementación
// lo cree (mismo patrón que `m-bigint.spec.ts` en TASK-db).
import {
  buildExpenseEntries,
  buildIncomeEntries,
  buildTransferEntries,
  buildLoanEntries,
  buildLoanRepaymentEntries,
  buildLoanWriteOffEntries,
  buildOpeningBalanceEntries,
  buildReversalEntries,
} from './entry-builders';
import { SplitMismatchException } from '../../transactions/exceptions/split-mismatch.exception';
import { InvalidInputException } from '../../common/errors/invalid-input.exception';
import { SameAccountException } from '../../transactions/exceptions/same-account.exception';
import { EmptyOpeningBalanceException } from '../../transactions/exceptions/empty-opening-balance.exception';

interface EntryLike {
  accountId: string;
  amountCents: bigint;
}

function sumEntries(entries: EntryLike[]): bigint {
  return entries.reduce((acc, e) => acc + e.amountCents, 0n);
}

/**
 * Una sola invocación: si el builder tuviera efectos secundarios, dos
 * llamadas separadas (una para `toThrow`, otra dentro de un `try/catch`
 * para el `code`) no garantizan probar el mismo caso dos veces.
 */
function expectRejection(
  fn: () => unknown,
  ExceptionClass: new (...args: never[]) => Error,
  code: string,
): void {
  try {
    fn();
    fail(`debía lanzar ${ExceptionClass.name}`);
  } catch (e) {
    expect(e).toBeInstanceOf(ExceptionClass);
    expect((e as Error & { code?: string }).code).toBe(code);
  }
}

describe('entry-builders — buildExpenseEntries', () => {
  it('T-U01: wifi $700 con TDC → 2 entries, suma 0n', () => {
    const entries = buildExpenseEntries({
      paidFromAccountId: 'A',
      totalCents: 70000n,
      lines: [{ categoryId: 'W', amountCents: 70000n }],
    });

    expect(entries).toEqual([
      { accountId: 'A', amountCents: -70000n },
      { accountId: 'W', amountCents: 70000n },
    ]);
    expect(sumEntries(entries)).toBe(0n);
  });

  it('T-U02: cena $800 con TDC, mitad prestada a Fer → 3 entries, suma 0n', () => {
    const entries = buildExpenseEntries({
      paidFromAccountId: 'A',
      totalCents: 80000n,
      lines: [{ categoryId: 'C', amountCents: 40000n }],
      lentTo: [{ receivableAccountId: 'F', amountCents: 40000n }],
    });

    expect(entries).toHaveLength(3);
    expect(sumEntries(entries)).toBe(0n);
    expect(entries).toEqual([
      { accountId: 'A', amountCents: -80000n },
      { accountId: 'C', amountCents: 40000n },
      { accountId: 'F', amountCents: 40000n },
    ]);
  });

  it('T-U03: total=80000n pero las partes suman 70000n → SplitMismatchException (SPLIT_TOTAL_MISMATCH)', () => {
    expectRejection(
      () =>
        buildExpenseEntries({
          paidFromAccountId: 'A',
          totalCents: 80000n,
          lines: [{ categoryId: 'C', amountCents: 70000n }],
        }),
      SplitMismatchException,
      'SPLIT_TOTAL_MISMATCH',
    );
  });

  it('T-U04: lines:[{C, 0n}] → InvalidInputException (INVALID_INPUT); ningún entry en cero sale jamás de un builder', () => {
    expectRejection(
      () =>
        buildExpenseEntries({
          paidFromAccountId: 'A',
          totalCents: 0n,
          lines: [{ categoryId: 'C', amountCents: 0n }],
        }),
      InvalidInputException,
      'INVALID_INPUT',
    );
  });

  it('T-U05: mismo categoryId dos veces en lines → NO se colapsa, 3 entries, suma 0n', () => {
    const entries = buildExpenseEntries({
      paidFromAccountId: 'A',
      totalCents: 70000n,
      lines: [
        { categoryId: 'C', amountCents: 30000n },
        { categoryId: 'C', amountCents: 40000n },
      ],
    });

    expect(entries).toHaveLength(3);
    expect(entries.filter((e: EntryLike) => e.accountId === 'C')).toHaveLength(2);
    expect(sumEntries(entries)).toBe(0n);
  });
});

describe('entry-builders — buildIncomeEntries', () => {
  it('T-U06: nómina $10,000 a Nu ← Sueldo', () => {
    const entries = buildIncomeEntries({ toAccountId: 'Nu', sourceId: 'S', amountCents: 1000000n });
    expect(entries).toEqual([
      { accountId: 'Nu', amountCents: 1000000n },
      { accountId: 'S', amountCents: -1000000n },
    ]);
  });
});

describe('entry-builders — buildTransferEntries', () => {
  it('T-U07: Nu → TDC de $700', () => {
    const entries = buildTransferEntries({ fromAccountId: 'Nu', toAccountId: 'TDC', amountCents: 70000n });
    expect(entries).toEqual([
      { accountId: 'Nu', amountCents: -70000n },
      { accountId: 'TDC', amountCents: 70000n },
    ]);
  });

  it('T-U08: from === to → SameAccountException (SAME_ACCOUNT_TRANSFER)', () => {
    expectRejection(
      () => buildTransferEntries({ fromAccountId: 'Nu', toAccountId: 'Nu', amountCents: 70000n }),
      SameAccountException,
      'SAME_ACCOUNT_TRANSFER',
    );
  });
});

describe('entry-builders — buildLoanEntries', () => {
  it('T-U09: préstamo $500 Nu → Fer', () => {
    const entries = buildLoanEntries({ fromAccountId: 'Nu', receivableAccountId: 'F', amountCents: 50000n });
    expect(entries).toEqual([
      { accountId: 'Nu', amountCents: -50000n },
      { accountId: 'F', amountCents: 50000n },
    ]);
  });
});

describe('entry-builders — buildLoanRepaymentEntries', () => {
  it('T-U10: cobro $500 de Fer → Nu', () => {
    const entries = buildLoanRepaymentEntries({ receivableAccountId: 'F', toAccountId: 'Nu', amountCents: 50000n });
    expect(entries).toEqual([
      { accountId: 'Nu', amountCents: 50000n },
      { accountId: 'F', amountCents: -50000n },
    ]);
  });
});

describe('entry-builders — buildLoanWriteOffEntries', () => {
  it('T-U11: préstamo incobrable $500', () => {
    const entries = buildLoanWriteOffEntries({ receivableAccountId: 'F', categoryId: 'P', amountCents: 50000n });
    expect(entries).toEqual([
      { accountId: 'F', amountCents: -50000n },
      { accountId: 'P', amountCents: 50000n },
    ]);
  });
});

describe('entry-builders — buildOpeningBalanceEntries', () => {
  it('T-U12: onboarding con 3 cuentas → 4 entries, equity −830000n, suma 0n', () => {
    const entries = buildOpeningBalanceEntries({
      balances: [
        { accountId: 'Nu', balanceCents: 1000000n },
        { accountId: 'TDC', balanceCents: -250000n },
        { accountId: 'Ef', balanceCents: 80000n },
      ],
      equityAccountId: 'E',
    });

    expect(entries).toHaveLength(4);
    expect(entries).toContainEqual({ accountId: 'E', amountCents: -830000n });
    expect(sumEntries(entries)).toBe(0n);
  });

  it('T-U13: balances que cancelan exacto (residual 0n) → 2 entries, SIN entry de equity', () => {
    const entries = buildOpeningBalanceEntries({
      balances: [
        { accountId: 'Nu', balanceCents: 1000n },
        { accountId: 'TDC', balanceCents: -1000n },
      ],
      equityAccountId: 'E',
    });

    expect(entries).toHaveLength(2);
    expect(entries.some((e: EntryLike) => e.accountId === 'E')).toBe(false);
  });

  it('T-U14: un saldo en 0n se descarta antes de construir → 2 entries', () => {
    const entries = buildOpeningBalanceEntries({
      balances: [
        { accountId: 'Nu', balanceCents: 1000n },
        { accountId: 'Ef', balanceCents: 0n },
      ],
      equityAccountId: 'E',
    });

    expect(entries).toEqual([
      { accountId: 'Nu', amountCents: 1000n },
      { accountId: 'E', amountCents: -1000n },
    ]);
  });

  it('T-U15: balances:[{Nu,0n}] → EmptyOpeningBalanceException (EMPTY_OPENING_BALANCE)', () => {
    expectRejection(
      () => buildOpeningBalanceEntries({ balances: [{ accountId: 'Nu', balanceCents: 0n }], equityAccountId: 'E' }),
      EmptyOpeningBalanceException,
      'EMPTY_OPENING_BALANCE',
    );
  });
});

describe('entry-builders — buildReversalEntries', () => {
  it('T-U16: invierte todos los signos, mismo orden; magnitud positiva idéntica (R9)', () => {
    const original = [
      { accountId: 'A', amountCents: -70000n },
      { accountId: 'W', amountCents: 70000n },
    ];
    const reversal = buildReversalEntries(original);

    expect(reversal).toEqual([
      { accountId: 'A', amountCents: 70000n },
      { accountId: 'W', amountCents: -70000n },
    ]);

    const magnitude = (entries: typeof original) =>
      entries.filter((e) => e.amountCents > 0n).reduce((a, e) => a + e.amountCents, 0n);
    expect(magnitude(reversal)).toBe(magnitude(original));
  });
});
