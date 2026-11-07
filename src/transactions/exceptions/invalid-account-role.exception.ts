import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../../common/errors/domain.exception';

/** TASK-api.md §4/§9.1 — el `type` de la cuenta no corresponde a su rol en el request. */
export class InvalidAccountRoleException extends DomainException {
  constructor() {
    super('INVALID_ACCOUNT_ROLE', HttpStatus.UNPROCESSABLE_ENTITY, 'El tipo de cuenta no corresponde a su rol en la petición.');
  }
}
