import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../../common/errors/domain.exception';

/**
 * TASK-api.md §9.1/§9.2 — una sola clase para `PERIOD_CLOSED` (P1010/P1011,
 * y escrituras rechazadas sobre un periodo cerrado), `PERIOD_ALREADY_CLOSED`
 * (doble cierre) y `NEXT_PERIOD_CLOSED` (S-R2). Los tres son 409.
 */
export class ClosedPeriodException extends DomainException {
  constructor(code: 'PERIOD_CLOSED' | 'PERIOD_ALREADY_CLOSED' | 'NEXT_PERIOD_CLOSED' = 'PERIOD_CLOSED') {
    super(code, HttpStatus.CONFLICT, 'El periodo está cerrado.');
  }
}
