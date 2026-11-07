import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../../common/errors/domain.exception';

/** TASK-api.md §6.7, paso 5 — S-R9: no se permite escribir ledger contra una cuenta archivada. */
export class ArchivedAccountException extends DomainException {
  constructor() {
    super('ACCOUNT_ARCHIVED', HttpStatus.CONFLICT, 'La cuenta está archivada; no admite movimientos nuevos.');
  }
}
