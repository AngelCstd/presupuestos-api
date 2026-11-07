import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../../common/errors/domain.exception';

export class AllocationNotFoundException extends DomainException {
  constructor() {
    super('ALLOCATION_NOT_FOUND', HttpStatus.NOT_FOUND, 'La asignación no existe.');
  }
}
