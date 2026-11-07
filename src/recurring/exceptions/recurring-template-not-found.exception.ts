import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../../common/errors/domain.exception';

export class RecurringTemplateNotFoundException extends DomainException {
  constructor() {
    super('RECURRING_TEMPLATE_NOT_FOUND', HttpStatus.NOT_FOUND, 'La plantilla recurrente no existe.');
  }
}
