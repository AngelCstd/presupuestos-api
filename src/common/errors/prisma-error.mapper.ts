import { InternalServerErrorException } from '@nestjs/common';
import { parsePgError } from './pg-error';
import { DomainException } from './domain.exception';
import { InvalidInputException } from './invalid-input.exception';
import { ResourceInUseException } from './resource-in-use.exception';
import { UnbalancedTransactionException } from '../../transactions/exceptions/unbalanced-transaction.exception';
import { OwnershipMismatchException } from '../../transactions/exceptions/ownership-mismatch.exception';
import { MixedCurrencyException } from '../../transactions/exceptions/mixed-currency.exception';
import { ImmutableLedgerException } from '../../transactions/exceptions/immutable-ledger.exception';
import { InvalidReversalException } from '../../transactions/exceptions/invalid-reversal.exception';
import { InvalidBudgetCategoryException } from '../../budget/exceptions/invalid-budget-category.exception';
import { ClosedPeriodException } from '../../budget/exceptions/closed-period.exception';
import { PeriodOverlapException } from '../../budget/exceptions/period-overlap.exception';
import { AccountNotEmptyException } from '../../accounts/exceptions/account-not-empty.exception';

/**
 * TASK-api.md §9.2 — extiende íntegra la tabla de TASK-db.md §6 con
 * `code`. NO discrimina los `23505` por nombre de constraint
 * (`transactions_reverses_uniq`, `accounts_user_name_active_uniq`,
 * `budget_entries_rollover_uniq`): eso necesita saber QUÉ constraint se
 * esperaba en cada operación concreta, algo que solo conoce el Service
 * que la llamó — vive ahí, no en este mapeo genérico (loop 2).
 */
export class PrismaErrorMapper {
  static toDomainException(e: unknown): DomainException | InternalServerErrorException {
    const parsed = parsePgError(e);
    if (!parsed) {
      return new InternalServerErrorException();
    }

    switch (parsed.sqlstate) {
      case 'P1001':
      case 'P1002':
        return new UnbalancedTransactionException();
      case 'P1003':
        return new OwnershipMismatchException();
      case 'P1004':
        return new MixedCurrencyException();
      case 'P1005':
      case 'P1006':
        return new ImmutableLedgerException();
      case 'P1007':
        return new InvalidBudgetCategoryException();
      case 'P1008':
        return new AccountNotEmptyException();
      case 'P1009':
        return new InvalidReversalException('INVALID_REVERSAL');
      case 'P1010':
      case 'P1011':
        return new ClosedPeriodException('PERIOD_CLOSED');
      case '23P01':
        return new PeriodOverlapException();
      case '23503':
        return new ResourceInUseException();
      case '23514':
        return new InvalidInputException();
      case '25P02':
      default:
        // 25P02 "nunca debería llegar" (§9.2) — es el mismo fallback que
        // cualquier SQLSTATE no mapeado explícitamente.
        return new InternalServerErrorException();
    }
  }
}
