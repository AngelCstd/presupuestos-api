import { Transform } from 'class-transformer';
import { registerDecorator, ValidationOptions } from 'class-validator';

const CENTS_REGEX = /^-?\d{1,19}$/;

/**
 * TASK-api.md §5.5 — string de centavos enteros, entrada y salida, regex
 * `/^-?\d{1,19}$/`. Decorador compuesto: valida el formato Y transforma a
 * `bigint` en un solo paso — ningún DTO necesita un `@Transform` aparte.
 * Solo transforma valores que YA cumplen el formato; cualquier otra cosa
 * (número, string con formato distinto) llega intacta a la validación y
 * falla ahí, nunca silenciosamente.
 */
export function IsCentsString(validationOptions?: ValidationOptions): PropertyDecorator {
  return function (object: object, propertyName: string | symbol): void {
    const property = String(propertyName);

    Transform(({ value }: { value: unknown }) => {
      if (typeof value === 'string' && CENTS_REGEX.test(value)) {
        return BigInt(value);
      }
      return value;
    })(object, property);

    registerDecorator({
      name: 'isCentsString',
      target: object.constructor,
      propertyName: property,
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          return typeof value === 'bigint';
        },
        defaultMessage(): string {
          return `${property} must be a string of integer cents`;
        },
      },
    });
  };
}
