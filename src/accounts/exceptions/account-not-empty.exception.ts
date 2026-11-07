import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../../common/errors/domain.exception';

/** TASK-api.md §9.2 — mapea P1008 (R8 de TASK-db.md). */
export class AccountNotEmptyException extends DomainException {
  constructor() {
    super('ACCOUNT_NOT_EMPTY', HttpStatus.CONFLICT, 'La cuenta tiene saldo distinto de cero.');
  }
}
