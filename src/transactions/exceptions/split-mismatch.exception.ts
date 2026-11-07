import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../../common/errors/domain.exception';

/** TASK-api.md §9.1 — `sum(lines) + sum(lentTo) ≠ totalCents` (§4.1, regla 1). */
export class SplitMismatchException extends DomainException {
  constructor() {
    super('SPLIT_TOTAL_MISMATCH', HttpStatus.UNPROCESSABLE_ENTITY, 'Las partes no suman el total.');
  }
}
