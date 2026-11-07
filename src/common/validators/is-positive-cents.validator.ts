import { registerDecorator, ValidationOptions } from 'class-validator';

/**
 * Se apila sobre `@IsCentsString()`, nunca la sustituye — esa ya está
 * cerrada y probada (T-U19/T-U20) y admite negativos a propósito para
 * saldos iniciales. Corre después de que `@Transform` ya convirtió el
 * string a `bigint`; aquí solo se exige signo estrictamente positivo
 * para los montos donde el dominio lo pide (`totalCents`, líneas de
 * gasto, montos de ingreso/transferencia/préstamo).
 */
export function IsPositiveCents(validationOptions?: ValidationOptions): PropertyDecorator {
  return function (object: object, propertyName: string | symbol): void {
    registerDecorator({
      name: 'isPositiveCents',
      target: object.constructor,
      propertyName: String(propertyName),
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          return typeof value === 'bigint' && value > 0n;
        },
        defaultMessage(): string {
          return `${String(propertyName)} must be a positive string of integer cents`;
        },
      },
    });
  };
}
