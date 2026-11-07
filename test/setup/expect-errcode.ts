import type { PoolClient } from 'pg';
import { countRows, snapshotCounts } from './db';

export function getErrcode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    return String((err as { code: unknown }).code);
  }
  return undefined;
}

function errcodeMismatch(expected: string, caught: unknown, where: string): Error {
  if (caught === undefined) {
    return new Error(`Se esperaba ERRCODE ${expected} en ${where}, pero no lanzó ningún error.`);
  }
  const actual = getErrcode(caught);
  const message = caught instanceof Error ? caught.message : String(caught);
  return new Error(`Se esperaba ERRCODE ${expected} en ${where}, se obtuvo ${actual ?? '(sin código)'}: ${message}`);
}

/**
 * Para violaciones INMEDIATAS (statement-level): CHECKs, índices únicos,
 * FKs, y las reglas inmediatas R3/R5/R6/R7/R8/R10/R11.
 *
 * Usa un SAVEPOINT para poder seguir consultando la MISMA transacción
 * después del error (Postgres aborta la transacción completa ante
 * cualquier error; sin el savepoint, el conteo "después" fallaría con
 * 25P02). El estado se compara dentro de la transacción abierta, no tras
 * el ROLLBACK final de `withRollback` — de otro modo la comparación sería
 * trivialmente cierta pase lo que pase, porque todo se revierte al final
 * igualmente.
 */
export async function expectImmediateRejection(
  client: PoolClient,
  action: () => Promise<unknown>,
  errcode: string,
  tables: string | readonly string[],
): Promise<void> {
  const tableList = Array.isArray(tables) ? tables : [tables as string];
  await client.query('SAVEPOINT expect_immediate');
  const before = await snapshotCounts(client, tableList);

  let caught: unknown;
  try {
    await action();
  } catch (err) {
    caught = err;
  }

  await client.query('ROLLBACK TO SAVEPOINT expect_immediate');
  const after = await snapshotCounts(client, tableList);

  const actual = getErrcode(caught);
  if (caught === undefined || actual !== errcode) {
    throw errcodeMismatch(errcode, caught, 'el statement');
  }
  expect(after).toEqual(before);
}

/**
 * Igual que `expectImmediateRejection` pero sin comparar estado — para
 * casos donde el conteo relevante no es de una tabla simple (ej. un valor
 * de columna que no debió cambiar). El caller hace su propia verificación
 * "antes/después" alrededor de esta llamada.
 */
export async function expectImmediateErrcode(
  client: PoolClient,
  action: () => Promise<unknown>,
  errcode: string,
): Promise<void> {
  await client.query('SAVEPOINT expect_immediate_bare');
  let caught: unknown;
  try {
    await action();
  } catch (err) {
    caught = err;
  }
  await client.query('ROLLBACK TO SAVEPOINT expect_immediate_bare');
  const actual = getErrcode(caught);
  if (caught === undefined || actual !== errcode) {
    throw errcodeMismatch(errcode, caught, 'el statement');
  }
}

export async function expectCountUnchanged(
  client: PoolClient,
  table: string,
  action: () => Promise<void>,
): Promise<void> {
  const before = await countRows(client, table);
  await action();
  const after = await countRows(client, table);
  expect(after).toBe(before);
}
