// TASK-api.md §9.2 — mapeo íntegro de TASK-db.md §6, extendido con `code`.
// Grupo U (T-U23), unit, sin base de datos real (mismos errores de Prisma
// construidos a mano que en pg-error.spec.ts). `prisma-error.mapper.ts` no
// existe todavía.
//
// No cubre las variantes de 23505 con nombre de constraint
// (transactions_reverses_uniq, accounts_user_name_active_uniq,
// budget_entries_rollover_uniq) — T-U23 enumera literalmente
// "P1001…P1011, 23P01, 23503, 23514, 25P02", quince códigos que se
// resuelven sin desambiguar por constraint.
import { InternalServerErrorException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaErrorMapper } from './prisma-error.mapper';
import { UnbalancedTransactionException } from '../../transactions/exceptions/unbalanced-transaction.exception';
import { OwnershipMismatchException } from '../../transactions/exceptions/ownership-mismatch.exception';
import { MixedCurrencyException } from '../../transactions/exceptions/mixed-currency.exception';
import { ImmutableLedgerException } from '../../transactions/exceptions/immutable-ledger.exception';
import { InvalidBudgetCategoryException } from '../../budget/exceptions/invalid-budget-category.exception';
import { AccountNotEmptyException } from '../../accounts/exceptions/account-not-empty.exception';
import { InvalidReversalException } from '../../transactions/exceptions/invalid-reversal.exception';
import { ClosedPeriodException } from '../../budget/exceptions/closed-period.exception';
import { PeriodOverlapException } from '../../budget/exceptions/period-overlap.exception';
import { ResourceInUseException } from './resource-in-use.exception';
import { InvalidInputException } from './invalid-input.exception';

function fakePgError(sqlstate: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('raw query failed', {
    code: 'P2010',
    clientVersion: '5.22.0',
    meta: { code: sqlstate, message: `error simulado para SQLSTATE ${sqlstate}` },
  });
}

describe('prisma-error.mapper — PrismaErrorMapper.toDomainException (T-U23)', () => {
  it.each([
    ['P1001', UnbalancedTransactionException, 422, 'UNBALANCED_TRANSACTION'],
    ['P1002', UnbalancedTransactionException, 422, 'UNBALANCED_TRANSACTION'],
    ['P1003', OwnershipMismatchException, 403, 'OWNERSHIP_MISMATCH'],
    ['P1004', MixedCurrencyException, 422, 'MIXED_CURRENCY'],
    ['P1005', ImmutableLedgerException, 409, 'IMMUTABLE_LEDGER'],
    ['P1006', ImmutableLedgerException, 409, 'IMMUTABLE_LEDGER'],
    ['P1007', InvalidBudgetCategoryException, 422, 'INVALID_BUDGET_CATEGORY'],
    ['P1008', AccountNotEmptyException, 409, 'ACCOUNT_NOT_EMPTY'],
    ['P1009', InvalidReversalException, 422, 'INVALID_REVERSAL'],
    ['P1010', ClosedPeriodException, 409, 'PERIOD_CLOSED'],
    ['P1011', ClosedPeriodException, 409, 'PERIOD_CLOSED'],
    ['23P01', PeriodOverlapException, 409, 'PERIOD_OVERLAP'],
    ['23503', ResourceInUseException, 409, 'RESOURCE_IN_USE'],
    ['23514', InvalidInputException, 422, 'INVALID_INPUT'],
  ] as const)('SQLSTATE %s → %p, %i, %s (code en la propia excepción, DomainException)', (sqlstate, ExceptionClass, status, code) => {
    const domainException = PrismaErrorMapper.toDomainException(fakePgError(sqlstate));

    expect(domainException).toBeInstanceOf(ExceptionClass);
    expect(domainException.getStatus()).toBe(status);
    expect((domainException as unknown as { code: string }).code).toBe(code);
  });

  it('SQLSTATE 25P02 → InternalServerErrorException, 500 — "nunca debería llegar" (§9.2)', () => {
    // Excepción estándar de Nest, no un DomainException propio: el `code`
    // INTERNAL_ERROR para cualquier HttpException de 500 sin `code` lo
    // deriva GlobalExceptionFilter (§5.3), no la excepción misma.
    const domainException = PrismaErrorMapper.toDomainException(fakePgError('25P02'));

    expect(domainException).toBeInstanceOf(InternalServerErrorException);
    expect(domainException.getStatus()).toBe(500);
  });
});
