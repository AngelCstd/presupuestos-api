import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../../common/errors/domain.exception';

/** TASK-api.md §4 — un accountId apunta a una cuenta `is_system = true`, nunca direccionable. */
export class SystemAccountException extends DomainException {
  constructor() {
    super('SYSTEM_ACCOUNT_NOT_ADDRESSABLE', HttpStatus.FORBIDDEN, 'Esa cuenta es interna del sistema y no es direccionable.');
  }
}
