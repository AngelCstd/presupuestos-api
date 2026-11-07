import type { PoolClient } from 'pg';
import { pool, snapshotCounts } from './db';
import { getErrcode } from './expect-errcode';

/**
 * ⚠️ Helper indispensable para R1, R2, R4 y R9 (TASK-db.md §5.1): esas
 * reglas son `DEFERRABLE INITIALLY DEFERRED` y solo se evalúan al COMMIT.
 * NUNCA usar `withRollback` para probarlas — como nunca llega al COMMIT,
 * el trigger jamás se dispara y el test pasa sin haber probado nada.
 *
 * `fn` hace los INSERTs (sin lanzar por sí solos); esta función hace el
 * COMMIT explícito donde se espera que el error aparezca.
 */
export async function withCommit(fn: (client: PoolClient) => Promise<void>): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await fn(client);
    await client.query('COMMIT');
  } finally {
    client.release();
  }
}

/**
 * Dos fases explícitas, para T-A08: insertar sin cerrar la transacción
 * (debe pasar sin error), seguir insertando, y solo entonces hacer commit.
 * Se expone el client crudo para que el test controle cada paso.
 */
export async function beginTx(): Promise<PoolClient> {
  const client = await pool.connect();
  await client.query('BEGIN');
  return client;
}

export async function commitTx(client: PoolClient): Promise<void> {
  try {
    await client.query('COMMIT');
  } finally {
    client.release();
  }
}

/**
 * Espera que el COMMIT falle con el ERRCODE dado. Un COMMIT fallido por un
 * constraint trigger diferido aborta toda la transacción del lado del
 * servidor — no hace falta ROLLBACK manual ni limpieza posterior; no
 * queda ninguna fila escrita.
 */
export async function expectDeferredRejection(
  fn: (client: PoolClient) => Promise<void>,
  errcode: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await fn(client);
    let caught: unknown;
    try {
      await client.query('COMMIT');
    } catch (err) {
      caught = err;
    }
    const actual = getErrcode(caught);
    if (caught === undefined || actual !== errcode) {
      const message = caught instanceof Error ? caught.message : String(caught);
      throw new Error(
        `Se esperaba ERRCODE ${errcode} en el COMMIT, se obtuvo ${actual ?? '(sin código)'}: ${message}`,
      );
    }
  } finally {
    client.release();
  }
}

/**
 * Combina `expectDeferredRejection` con la verificación de estado intacto,
 * tomando el snapshot en el pool (fuera de la transacción que se aborta).
 */
export async function expectDeferredRejectionIntact(
  fn: (client: PoolClient) => Promise<void>,
  errcode: string,
  tables: readonly string[],
): Promise<void> {
  const before = await snapshotCounts(pool, tables);
  await expectDeferredRejection(fn, errcode);
  const after = await snapshotCounts(pool, tables);
  expect(after).toEqual(before);
}

/**
 * Usado por los archivos que SÍ dejan datos permanentes (a-balance-zero,
 * c-immutability-reversal, h-idempotency): `entries`/`transactions` son
 * inmutables (R5/R6), así que un DELETE de limpieza no es viable.
 * TRUNCATE no dispara triggers de fila, así que sortea la inmutabilidad.
 * Se trunca `auth.users` (no `profiles`): `profiles.id` referencia
 * `auth.users.id` (§3.7), así que es la raíz real de la cadena de FKs.
 * CASCADE alcanza `profiles` y de ahí a las seis tablas de esta capa, sin
 * importar que esas FKs sean RESTRICT — el CASCADE de TRUNCATE es una
 * opción propia, independiente de ON DELETE. Truncar solo `profiles`
 * dejaría filas huérfanas acumulándose en `auth.users` entre tests.
 */
export async function truncateAll(client: PoolClient): Promise<void> {
  await client.query('TRUNCATE TABLE auth.users RESTART IDENTITY CASCADE');
}
