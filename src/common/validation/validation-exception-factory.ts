import { BadRequestException } from '@nestjs/common';
import type { ValidationError } from '@nestjs/common';

/**
 * TASK-api.md §5.3 — errores de validación agregan `code: VALIDATION_FAILED`
 * y `details: [{field, constraint}]`. El `ValidationPipe` de Nest no
 * produce esa forma por default (un arreglo de strings) — se construye
 * aquí con `exceptionFactory`, no en el filtro: es la única capa que
 * conoce el `ValidationError[]` original con nombre de campo y
 * constraint por separado.
 *
 * Compartido entre `src/main.ts` (bootstrap real) y
 * `test/integration/api/_helpers/app.ts` (arnés de test) — misma razón
 * que `bigint-json-override.ts`: dos copias de la misma lógica solo
 * pueden divergir, nunca ayudar.
 */
export function validationExceptionFactory(errors: ValidationError[]): BadRequestException {
  const details = errors.flatMap((err) =>
    Object.entries(err.constraints ?? {}).map(([, constraint]) => ({ field: err.property, constraint })),
  );
  return new BadRequestException({
    code: 'VALIDATION_FAILED',
    message: 'La petición no pasó validación.',
    details,
  });
}
