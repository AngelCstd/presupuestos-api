import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../../common/errors/domain.exception';

/** Archivar lo archivado, o desarchivar lo activo. */
export class ArchiveStateException extends DomainException {
  constructor(code: 'ALREADY_ARCHIVED' | 'NOT_ARCHIVED') {
    super(
      code,
      HttpStatus.CONFLICT,
      code === 'ALREADY_ARCHIVED' ? 'La cuenta ya está archivada.' : 'La cuenta no está archivada.',
    );
  }
}
