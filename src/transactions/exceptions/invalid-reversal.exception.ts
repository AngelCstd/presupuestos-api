import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../../common/errors/domain.exception';

/**
 * TASK-api.md §9.1/§9.2 — una sola clase para tres códigos:
 * `INVALID_REVERSAL` (P1009, mapeo de Postgres, 422),
 * `ALREADY_REVERSED` y `CANNOT_REVERSE_REVERSAL` (S-R7, pre-validados
 * por el Service, 409 los dos).
 */
export class InvalidReversalException extends DomainException {
  constructor(code: 'INVALID_REVERSAL' | 'ALREADY_REVERSED' | 'CANNOT_REVERSE_REVERSAL' = 'INVALID_REVERSAL') {
    const status = code === 'INVALID_REVERSAL' ? HttpStatus.UNPROCESSABLE_ENTITY : HttpStatus.CONFLICT;
    super(code, status, 'La reversa no es válida.');
  }
}
