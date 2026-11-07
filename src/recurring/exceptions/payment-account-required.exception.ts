import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../../common/errors/domain.exception';

/** TASK-api.md §6.9 — `confirm` sin cuenta de pago ni en el body ni en la plantilla. */
export class PaymentAccountRequiredException extends DomainException {
  constructor() {
    super('PAYMENT_ACCOUNT_REQUIRED', HttpStatus.UNPROCESSABLE_ENTITY, 'Falta una cuenta de pago, en el body o en la plantilla.');
  }
}
