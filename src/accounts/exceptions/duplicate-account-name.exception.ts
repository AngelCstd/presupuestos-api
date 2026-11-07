import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../../common/errors/domain.exception';

/** El nombre es único entre TODAS las cuentas activas del usuario (§6.5/§6.6). */
export class DuplicateAccountNameException extends DomainException {
  constructor() {
    super('DUPLICATE_ACCOUNT_NAME', HttpStatus.CONFLICT, 'Ya existe una cuenta activa con ese nombre.');
  }
}
