import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../../common/errors/domain.exception';

/** S-R6 — sobre con presupuesto asignado en un periodo abierto no se puede archivar. */
export class CategoryHasAllocationsException extends DomainException {
  constructor() {
    super('CATEGORY_HAS_ALLOCATIONS', HttpStatus.CONFLICT, 'El sobre tiene presupuesto asignado en un periodo abierto.');
  }
}
