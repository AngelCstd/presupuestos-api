import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../../common/errors/domain.exception';

/** TASK-api.md §9.2 — mapea P1005/P1006 (R5/R6 de TASK-db.md). */
export class ImmutableLedgerException extends DomainException {
  constructor() {
    super('IMMUTABLE_LEDGER', HttpStatus.CONFLICT, 'El ledger es inmutable; usa una reversa.');
  }
}
