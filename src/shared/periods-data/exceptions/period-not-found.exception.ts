import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../../../common/errors/domain.exception';

/**
 * Vive en `shared/periods-data`, no en `budget/`: la usan tanto
 * `BudgetModule` (periodos, asignaciones) como `InsightsModule`
 * (`category-balances?periodId=`) — un módulo de dominio no puede
 * importar la excepción de otro (D4), así que el código compartido vive
 * en la infraestructura compartida, igual que el repository mismo.
 */
export class PeriodNotFoundException extends DomainException {
  constructor() {
    super('PERIOD_NOT_FOUND', HttpStatus.NOT_FOUND, 'El periodo no existe.');
  }
}
