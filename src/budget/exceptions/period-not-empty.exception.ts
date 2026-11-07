import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../../common/errors/domain.exception';

/** TASK-api.md §9.1 — DELETE de un periodo con asignaciones vigentes. */
export class PeriodNotEmptyException extends DomainException {
  constructor() {
    super('PERIOD_NOT_EMPTY', HttpStatus.CONFLICT, 'El periodo tiene asignaciones vigentes.');
  }
}
