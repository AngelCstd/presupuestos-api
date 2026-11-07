import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../../common/errors/domain.exception';

/** TASK-api.md §9.1 — P-01: no existe periodo siguiente contra el cual arrastrar. */
export class NextPeriodRequiredException extends DomainException {
  constructor() {
    super('NEXT_PERIOD_REQUIRED', HttpStatus.CONFLICT, 'No existe un periodo siguiente contra el cual cerrar.');
  }
}
