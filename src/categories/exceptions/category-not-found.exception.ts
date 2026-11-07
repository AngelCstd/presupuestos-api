import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../../common/errors/domain.exception';

export class CategoryNotFoundException extends DomainException {
  constructor() {
    super('CATEGORY_NOT_FOUND', HttpStatus.NOT_FOUND, 'El sobre no existe.');
  }
}
