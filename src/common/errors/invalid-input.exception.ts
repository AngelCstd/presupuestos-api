import { HttpStatus } from '@nestjs/common';
import { DomainException } from './domain.exception';

/**
 * TASK-api.md §9.2 — mapea `23514` (violación de CHECK). También la
 * lanzan los builders directamente (§4.7, T-U04): ningún entry en cero
 * sale jamás de un builder.
 */
export class InvalidInputException extends DomainException {
  constructor(message = 'Entrada inválida para el dominio.') {
    super('INVALID_INPUT', HttpStatus.UNPROCESSABLE_ENTITY, message);
  }
}
