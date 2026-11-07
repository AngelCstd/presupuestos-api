import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../../common/errors/domain.exception';

/** TASK-api.md §9.2 — mapea P1001/P1002 (R1/R2 de TASK-db.md). */
export class UnbalancedTransactionException extends DomainException {
  constructor() {
    super('UNBALANCED_TRANSACTION', HttpStatus.UNPROCESSABLE_ENTITY, 'La transacción no está balanceada.');
  }
}
