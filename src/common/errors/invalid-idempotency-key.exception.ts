import { HttpStatus } from '@nestjs/common';
import { DomainException } from './domain.exception';

/** TASK-api.md §5.1 — el header `Idempotency-Key` no es un UUID válido. */
export class InvalidIdempotencyKeyException extends DomainException {
  constructor() {
    super('IDEMPOTENCY_KEY_INVALID', HttpStatus.BAD_REQUEST, 'El header Idempotency-Key no es un UUID válido.');
  }
}
