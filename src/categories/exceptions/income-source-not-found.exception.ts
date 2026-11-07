import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../../common/errors/domain.exception';

export class IncomeSourceNotFoundException extends DomainException {
  constructor() {
    super('INCOME_SOURCE_NOT_FOUND', HttpStatus.NOT_FOUND, 'La fuente de ingreso no existe.');
  }
}
