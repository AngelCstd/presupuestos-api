import { ForbiddenException } from '@nestjs/common';

/**
 * TASK-auth.md, "Mecánica de creación de profiles": usuario con
 * deleted_at IS NOT NULL que se autentica → rechazo explícito (403), sin
 * reactivación. Mapeo confirmado en "Mapeo de errores → excepción NestJS
 * → status HTTP".
 */
export class ProfileDeletedException extends ForbiddenException {
  constructor() {
    super('Perfil eliminado');
  }
}
