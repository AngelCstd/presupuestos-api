import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../../common/errors/domain.exception';

/** TASK-api.md §9.1 — ningún periodo cubre hoy. */
export class NoCurrentPeriodException extends DomainException {
  constructor() {
    super('NO_CURRENT_PERIOD', HttpStatus.NOT_FOUND, 'Ningún periodo cubre hoy.');
  }
}
