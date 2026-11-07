import { seedFixture, type Fixture, type UserFixture } from '../../../setup/fixture';
import { pool } from '../../../setup/db';

export { pool };
export type { Fixture, UserFixture };

/**
 * Los tests HTTP usan una app de Nest real con su propio PrismaClient
 * (conexión distinta a la del pool de test) — el fixture tiene que quedar
 * COMMIT de verdad para que la app lo vea, a diferencia de
 * `withRollback()` que usan los tests de la capa de datos.
 */
export async function seedFixtureCommitted(): Promise<Fixture> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const fixture = await seedFixture(client);
    await client.query('COMMIT');
    return fixture;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
