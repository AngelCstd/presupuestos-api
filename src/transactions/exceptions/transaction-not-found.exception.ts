import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../../common/errors/domain.exception';

export class TransactionNotFoundException extends DomainException {
  constructor() {
    super('TRANSACTION_NOT_FOUND', HttpStatus.NOT_FOUND, 'La transacción no existe.');
  }
}
