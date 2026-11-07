import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../../common/errors/domain.exception';

/** TASK-api.md §4/§9.2 — mapea P1004 (R4); también la pre-valida el Service. */
export class MixedCurrencyException extends DomainException {
  constructor() {
    super('MIXED_CURRENCY', HttpStatus.UNPROCESSABLE_ENTITY, 'Las cuentas involucradas no comparten moneda.');
  }
}
