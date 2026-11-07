import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../../common/errors/domain.exception';

/** TASK-api.md §6.4/§9.1 — timezone que no existe en pg_timezone_names. */
export class InvalidTimezoneException extends DomainException {
  constructor() {
    super('INVALID_TIMEZONE', HttpStatus.BAD_REQUEST, 'La zona horaria no es válida.');
  }
}
