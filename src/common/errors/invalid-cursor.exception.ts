import { HttpStatus } from '@nestjs/common';
import { DomainException } from './domain.exception';

/** TASK-api.md §5.2/§9.1 — cursor de paginación no decodificable. */
export class InvalidCursorException extends DomainException {
  constructor() {
    super('INVALID_CURSOR', HttpStatus.BAD_REQUEST, 'El cursor no se pudo decodificar.');
  }
}
