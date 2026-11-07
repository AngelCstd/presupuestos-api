import type supertest from 'supertest';
import { pool } from './seed';

type Response = supertest.Response;

interface CountQuery {
  sql: string;
  params?: unknown[];
}

/**
 * Patrón unificado de TASK-api.md §11 para todo test ❌: UNA sola
 * invocación HTTP (`perform`, con `.expect(status)` ya encadenado por el
 * caller para el mensaje de error nativo de supertest), verificación del
 * `code` exacto, y conteo antes/después idéntico sobre las tablas que la
 * operación pudo haber tocado. `countQueries` siempre debe venir acotado a
 * los IDs del fixture del test — nunca un conteo global de tabla.
 */
export async function expectRejection(params: {
  perform: () => Promise<Response>;
  code: string;
  countQueries: CountQuery[];
}): Promise<Response> {
  const before = await Promise.all(params.countQueries.map((q) => pool.query(q.sql, q.params ?? [])));

  const res = await params.perform();
  expect(res.body.code).toBe(params.code);

  const after = await Promise.all(params.countQueries.map((q) => pool.query(q.sql, q.params ?? [])));
  after.forEach((a, i) => {
    expect(a.rows[0].n).toBe(before[i].rows[0].n);
  });

  return res;
}

export function countTransactionsSql(): CountQuery['sql'] {
  return 'SELECT count(*)::int AS n FROM transactions WHERE user_id = $1';
}

export function countEntriesSql(): CountQuery['sql'] {
  return 'SELECT count(*)::int AS n FROM entries WHERE user_id = $1';
}

export function countBudgetEntriesSql(): CountQuery['sql'] {
  return 'SELECT count(*)::int AS n FROM budget_entries WHERE user_id = $1';
}
