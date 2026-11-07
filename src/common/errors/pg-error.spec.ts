// TASK-api.md §5.4 — extracción del nombre de constraint desde el error
// crudo de Postgres, nunca del texto semántico del mensaje. Grupo U
// (T-U21–U22), unit, sin base de datos real (se construye un error de
// Prisma real, no un mock inventado). `pg-error.ts` no existe todavía.
import { Prisma } from '@prisma/client';
import { parsePgError } from './pg-error';

function fakeP2010(sqlstate: string, constraint: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('raw query failed', {
    code: 'P2010',
    clientVersion: '5.22.0',
    meta: {
      code: sqlstate,
      message: `duplicate key value violates unique constraint "${constraint}"`,
    },
  });
}

describe('pg-error — parsePgError', () => {
  it('T-U21: P2010 con SQLSTATE 23505 y constraint accounts_user_name_active_uniq', () => {
    const result = parsePgError(fakeP2010('23505', 'accounts_user_name_active_uniq'));

    expect(result).toEqual({ sqlstate: '23505', constraint: 'accounts_user_name_active_uniq' });
  });

  it.each([
    ['transactions_idempotency_uniq'],
    ['transactions_reverses_uniq'],
    ['accounts_user_name_active_uniq'],
    ['budget_entries_rollover_uniq'],
  ])('T-U22: extrae correctamente el constraint "%s" — un caso por nombre', (constraint) => {
    const result = parsePgError(fakeP2010('23505', constraint));

    expect(result).toEqual({ sqlstate: '23505', constraint });
  });
});
