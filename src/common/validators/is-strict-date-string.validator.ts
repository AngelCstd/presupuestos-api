import { registerDecorator, ValidationOptions } from 'class-validator';

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * TASK-api.md §5.5 — `YYYY-MM-DD` estricto. `@IsDateString()` de
 * class-validator acepta ISO 8601 completo (con hora); esto es más
 * estricto a propósito, para `bookedAt`/`startsOn`/`endsOn`/`nextDueOn`.
 */
export function IsStrictDateString(validationOptions?: ValidationOptions): PropertyDecorator {
  return function (object: object, propertyName: string | symbol): void {
    registerDecorator({
      name: 'isStrictDateString',
      target: object.constructor,
      propertyName: String(propertyName),
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          if (typeof value !== 'string') return false;
          const match = DATE_RE.exec(value);
          if (!match) return false;
          const [, y, m, d] = match;
          const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
          return (
            date.getUTCFullYear() === Number(y) && date.getUTCMonth() === Number(m) - 1 && date.getUTCDate() === Number(d)
          );
        },
        defaultMessage(): string {
          return `${String(propertyName)} must match YYYY-MM-DD`;
        },
      },
    });
  };
}
