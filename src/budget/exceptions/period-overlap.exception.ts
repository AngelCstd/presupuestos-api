import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../../common/errors/domain.exception';

/** TASK-api.md §9.2 — mapea 23P01 (el `EXCLUDE` de `budget_periods`). */
export class PeriodOverlapException extends DomainException {
  constructor() {
    super('PERIOD_OVERLAP', HttpStatus.CONFLICT, 'El rango se traslapa con otro periodo.');
  }
}
