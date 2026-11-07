import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../../../common/errors/domain.exception';

/**
 * Vive en `shared/accounts-data`, no en `accounts/`: la usan
 * `AccountsModule`, `TransactionsModule` y `RecurringModule` por igual
 * — cualquier módulo que resuelva `accountId`s vía
 * `IAccountRepository` (D4: un módulo de dominio no puede importar la
 * excepción de otro).
 */
export class AccountNotFoundException extends DomainException {
  constructor() {
    super('ACCOUNT_NOT_FOUND', HttpStatus.NOT_FOUND, 'La cuenta no existe.');
  }
}
