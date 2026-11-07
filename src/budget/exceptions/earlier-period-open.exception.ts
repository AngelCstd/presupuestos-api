import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../../common/errors/domain.exception';

/** TASK-api.md §9.1 — S-R8: existe otro periodo abierto anterior. */
export class EarlierPeriodOpenException extends DomainException {
  constructor() {
    super('EARLIER_PERIOD_OPEN', HttpStatus.CONFLICT, 'Existe un periodo anterior sin cerrar.');
  }
}
