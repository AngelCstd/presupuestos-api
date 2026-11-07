import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../../common/errors/domain.exception';

/** TASK-api.md §9.1/S-R5 — la cuenta ya tiene entries, su moneda no se puede cambiar. */
export class CurrencyLockedException extends DomainException {
  constructor() {
    super('CURRENCY_LOCKED', HttpStatus.CONFLICT, 'La cuenta ya tiene movimientos; su moneda no se puede cambiar.');
  }
}
