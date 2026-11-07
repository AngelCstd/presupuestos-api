// TASK-api.md §5.5 — regex /^-?\d{1,19}$/, sin punto, sin separadores de
// miles, sin símbolo de moneda, sin notación científica. Grupo U
// (T-U19–U20), unit, sin base de datos. `is-cents-string.validator.ts` no
// existe todavía.
//
// Se prueba montando una clase mínima decorada con @IsCentsString() y
// corriendo `plainToInstance` + `validate()` — es exactamente lo que hace
// `ValidationPipe({ transform: true })` por debajo, sin necesitar HTTP.
// Se asume que @IsCentsString() valida Y transforma en un solo decorador
// (no exige un @Transform aparte en cada DTO) — inferencia de forma, no
// de comportamiento: TASK-api.md solo dice "un validador propio
// @IsCentsString() + @Transform" sin aclarar si van en un decorador o dos.
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { IsCentsString } from './is-cents-string.validator';

class CentsTestDto {
  @IsCentsString()
  amountCents!: bigint;
}

describe('is-cents-string.validator — @IsCentsString()', () => {
  it.each([
    ['70000', 70000n],
    ['-830000', -830000n],
    ['0', 0n],
  ])('T-U19: "%s" es válido y se transforma a %s', async (input, expected) => {
    const instance = plainToInstance(CentsTestDto, { amountCents: input });
    const errors = await validate(instance);

    expect(errors).toHaveLength(0);
    expect(instance.amountCents).toBe(expected);
    expect(typeof instance.amountCents).toBe('bigint');
  });

  it.each([['700.00'], ['1,000'], ['$700'], ['7e3'], [700], ['']])(
    'T-U20: %s es rechazado con VALIDATION_FAILED',
    async (input) => {
      const instance = plainToInstance(CentsTestDto, { amountCents: input as unknown as string });
      const errors = await validate(instance);

      expect(errors.length).toBeGreaterThan(0);
    },
  );
});
