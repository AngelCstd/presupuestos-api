import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../../../common/errors/domain.exception';

/** TASK-api.md §2.2 (P-04) / §5.1 — conflicto detectado, fila aún no visible. Sin reintento. */
export class IdempotencyInFlightException extends DomainException {
  constructor() {
    super('IDEMPOTENCY_IN_FLIGHT', HttpStatus.CONFLICT, 'La escritura con esa llave sigue en curso.');
  }
}
