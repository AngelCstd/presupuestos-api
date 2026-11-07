import { Pool, types, type PoolClient } from 'pg';

// OID 20 = int8/bigint. node-postgres devuelve bigint como string por
// defecto para no perder precisión; todos los montos de prueba caben en
// un Number seguro, así que se parsean para que los tests puedan comparar
// con `toBe(70000)` en vez de `toBe('70000')`. La excepción deliberada es
// T-M01, que verifica la fidelidad de BigInt específicamente vía Prisma,
// no vía este cliente pg.
types.setTypeParser(20, (value: string) => Number.parseInt(value, 10));

export const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });

export async function closePool(): Promise<void> {
  await pool.end();
}

/**
 * Aislamiento estándar para reglas inmediatas (R3, R5-R8, R10, R11, CHECKs)
 * y para lecturas vía F1-F4: BEGIN, corre `fn`, SIEMPRE hace ROLLBACK.
 * No usar para R1/R2/R4/R9: son diferidos y el error solo aparece en el
 * COMMIT (ver test/setup/commit-helper.ts y TASK-db.md §5.1).
 */
export async function withRollback(fn: (client: PoolClient) => Promise<void>): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await fn(client);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

type Queryable = Pick<PoolClient, 'query'>;

export async function countRows(db: Queryable, table: string): Promise<number> {
  const { rows } = await db.query(`SELECT count(*)::int AS n FROM ${table}`);
  return rows[0].n as number;
}

export async function snapshotCounts(
  db: Queryable,
  tables: readonly string[],
): Promise<Record<string, number>> {
  const entries = await Promise.all(
    tables.map(async (table) => [table, await countRows(db, table)] as const),
  );
  return Object.fromEntries(entries);
}
