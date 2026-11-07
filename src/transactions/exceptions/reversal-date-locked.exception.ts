import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../../common/errors/domain.exception';

/** TASK-api.md §4.8 — bookedAt explícito al revertir una transacción que generó compensatorio de captura tardía. */
export class ReversalDateLockedException extends DomainException {
  constructor() {
    super('REVERSAL_DATE_LOCKED', HttpStatus.UNPROCESSABLE_ENTITY, 'No se puede sobreescribir la fecha de esta reversa.');
  }
}
