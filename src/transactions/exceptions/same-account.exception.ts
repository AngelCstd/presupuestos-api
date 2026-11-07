import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../../common/errors/domain.exception';

/**
 * TASK-api.md §9.1 — una sola clase para `SAME_ACCOUNT_TRANSFER`
 * (`buildTransferEntries`, §4.3) y `SAME_CATEGORY_MOVE`
 * (`POST /allocations/move`, loop 2, A08). El `code` distingue el caso.
 */
export class SameAccountException extends DomainException {
  constructor(code: 'SAME_ACCOUNT_TRANSFER' | 'SAME_CATEGORY_MOVE' = 'SAME_ACCOUNT_TRANSFER') {
    super(code, HttpStatus.UNPROCESSABLE_ENTITY, 'El origen y el destino son la misma cuenta.');
  }
}
