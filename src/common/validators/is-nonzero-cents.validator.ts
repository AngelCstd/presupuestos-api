import { registerDecorator, ValidationOptions } from 'class-validator';

/** `POST /periods/{id}/allocations` — amountCents puede ser negativo, nunca "0" (API-CONTRACT.md §12.2). */
export function IsNonZeroCents(validationOptions?: ValidationOptions): PropertyDecorator {
  return function (object: object, propertyName: string | symbol): void {
    registerDecorator({
      name: 'isNonZeroCents',
      target: object.constructor,
      propertyName: String(propertyName),
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          return typeof value === 'bigint' && value !== 0n;
        },
        defaultMessage(): string {
          return `${String(propertyName)} must be a non-zero string of integer cents`;
        },
      },
    });
  };
}
