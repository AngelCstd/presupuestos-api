import { HttpStatus } from '@nestjs/common';
import { DomainException } from './domain.exception';

/** TASK-api.md §9.2 — mapea 23503 (violación de FK genérica). */
export class ResourceInUseException extends DomainException {
  constructor() {
    super('RESOURCE_IN_USE', HttpStatus.CONFLICT, 'El recurso está referenciado por otro.');
  }
}
