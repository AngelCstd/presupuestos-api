import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../../common/errors/domain.exception';

/** TASK-api.md §9.2 — mapea P1003 (R3 de TASK-db.md). No debería ocurrir. */
export class OwnershipMismatchException extends DomainException {
  constructor() {
    super('OWNERSHIP_MISMATCH', HttpStatus.FORBIDDEN, 'Inconsistencia de propiedad detectada.');
  }
}
