import { HttpStatus } from '@nestjs/common';
import { DomainException } from './domain.exception';

/** TASK-api.md §5.1 — falta el header `Idempotency-Key` en un endpoint que lo exige. */
export class MissingIdempotencyKeyException extends DomainException {
  constructor() {
    super('IDEMPOTENCY_KEY_REQUIRED', HttpStatus.BAD_REQUEST, 'Falta el header Idempotency-Key.');
  }
}
