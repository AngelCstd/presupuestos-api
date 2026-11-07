import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../../common/errors/domain.exception';

/** TASK-api.md §9.1 — cero saldos distintos de cero (§4.7, reglas 3 y 5). */
export class EmptyOpeningBalanceException extends DomainException {
  constructor() {
    super('EMPTY_OPENING_BALANCE', HttpStatus.UNPROCESSABLE_ENTITY, 'Ningún saldo inicial es distinto de cero.');
  }
}
