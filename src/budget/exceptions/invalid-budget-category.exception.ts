import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../../common/errors/domain.exception';

/** TASK-api.md §9.2 — mapea P1007 (R7 de TASK-db.md). */
export class InvalidBudgetCategoryException extends DomainException {
  constructor() {
    super('INVALID_BUDGET_CATEGORY', HttpStatus.UNPROCESSABLE_ENTITY, 'El id no corresponde a un sobre.');
  }
}
