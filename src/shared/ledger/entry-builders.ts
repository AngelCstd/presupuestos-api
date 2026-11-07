import { SplitMismatchException } from '../../transactions/exceptions/split-mismatch.exception';
import { InvalidInputException } from '../../common/errors/invalid-input.exception';
import { SameAccountException } from '../../transactions/exceptions/same-account.exception';
import { EmptyOpeningBalanceException } from '../../transactions/exceptions/empty-opening-balance.exception';

/** TASK-api.md §4 — traducción de intención a partida doble, funciones puras. */
export interface EntryDraft {
  accountId: string;
  amountCents: bigint;
}

export function buildExpenseEntries(input: {
  paidFromAccountId: string;
  lines: Array<{ categoryId: string; amountCents: bigint }>;
  lentTo?: Array<{ receivableAccountId: string; amountCents: bigint }>;
  totalCents: bigint;
}): EntryDraft[] {
  const lentTo = input.lentTo ?? [];

  if (input.lines.length < 1) {
    throw new InvalidInputException('Se requiere al menos una línea de gasto.');
  }
  if (input.totalCents <= 0n) {
    throw new InvalidInputException('totalCents debe ser estrictamente positivo.');
  }
  for (const line of input.lines) {
    if (line.amountCents <= 0n) {
      throw new InvalidInputException('Los montos de las líneas deben ser estrictamente positivos.');
    }
  }
  for (const lent of lentTo) {
    if (lent.amountCents <= 0n) {
      throw new InvalidInputException('Los montos prestados deben ser estrictamente positivos.');
    }
  }

  const sum = input.lines.reduce((a, l) => a + l.amountCents, 0n) + lentTo.reduce((a, l) => a + l.amountCents, 0n);
  if (sum !== input.totalCents) {
    throw new SplitMismatchException();
  }

  const entries: EntryDraft[] = [{ accountId: input.paidFromAccountId, amountCents: -input.totalCents }];
  for (const line of input.lines) {
    entries.push({ accountId: line.categoryId, amountCents: line.amountCents });
  }
  for (const lent of lentTo) {
    entries.push({ accountId: lent.receivableAccountId, amountCents: lent.amountCents });
  }
  return entries;
}

export function buildIncomeEntries(input: {
  toAccountId: string;
  sourceId: string;
  amountCents: bigint;
}): EntryDraft[] {
  return [
    { accountId: input.toAccountId, amountCents: input.amountCents },
    { accountId: input.sourceId, amountCents: -input.amountCents },
  ];
}

export function buildTransferEntries(input: {
  fromAccountId: string;
  toAccountId: string;
  amountCents: bigint;
}): EntryDraft[] {
  if (input.fromAccountId === input.toAccountId) {
    throw new SameAccountException('SAME_ACCOUNT_TRANSFER');
  }
  return [
    { accountId: input.fromAccountId, amountCents: -input.amountCents },
    { accountId: input.toAccountId, amountCents: input.amountCents },
  ];
}

export function buildLoanEntries(input: {
  fromAccountId: string;
  receivableAccountId: string;
  amountCents: bigint;
}): EntryDraft[] {
  return [
    { accountId: input.fromAccountId, amountCents: -input.amountCents },
    { accountId: input.receivableAccountId, amountCents: input.amountCents },
  ];
}

export function buildLoanRepaymentEntries(input: {
  receivableAccountId: string;
  toAccountId: string;
  amountCents: bigint;
}): EntryDraft[] {
  return [
    { accountId: input.toAccountId, amountCents: input.amountCents },
    { accountId: input.receivableAccountId, amountCents: -input.amountCents },
  ];
}

export function buildLoanWriteOffEntries(input: {
  receivableAccountId: string;
  categoryId: string;
  amountCents: bigint;
}): EntryDraft[] {
  return [
    { accountId: input.receivableAccountId, amountCents: -input.amountCents },
    { accountId: input.categoryId, amountCents: input.amountCents },
  ];
}

export function buildOpeningBalanceEntries(input: {
  balances: Array<{ accountId: string; balanceCents: bigint }>;
  equityAccountId: string;
}): EntryDraft[] {
  const nonZero = input.balances.filter((b) => b.balanceCents !== 0n);
  if (nonZero.length === 0) {
    throw new EmptyOpeningBalanceException();
  }

  const entries: EntryDraft[] = nonZero.map((b) => ({ accountId: b.accountId, amountCents: b.balanceCents }));

  const residual = -nonZero.reduce((a, b) => a + b.balanceCents, 0n);
  if (residual !== 0n) {
    entries.push({ accountId: input.equityAccountId, amountCents: residual });
  }

  if (entries.length < 2) {
    throw new EmptyOpeningBalanceException();
  }

  return entries;
}

export function buildReversalEntries(originalEntries: EntryDraft[]): EntryDraft[] {
  return originalEntries.map((e) => ({ accountId: e.accountId, amountCents: -e.amountCents }));
}
