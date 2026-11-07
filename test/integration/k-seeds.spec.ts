import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { closePool, withRollback } from '../setup/db';

/**
 * Grupo K — `fn_seed_new_user` reducida a la cuenta de sistema (U21
 * revisado, migración `08_seed_equity_only`; ARCHITECTURE.md §3.12).
 * Las 7 categorías y "Sueldo" dejaron de sembrarse automáticamente —
 * pasan a ser una lista sugerida que presenta el frontend en el
 * onboarding, creada con `POST /categories`/`POST /income-sources`. La
 * cuenta de sistema sigue siendo obligatoria: es infraestructura, no
 * contenido, y el usuario no puede crearla por su cuenta.
 */
describe('Grupo K — fn_seed_new_user (U21, reducida a la cuenta de sistema)', () => {
  afterAll(async () => {
    await closePool();
  });

  // profiles.id referencia auth.users.id (§3.7) — auth.users la crea el
  // stub de TASK-auth, aplicado por globalSetup.
  async function insertProfile(client: PoolClient, userId: string): Promise<void> {
    await client.query('INSERT INTO auth.users (id) VALUES ($1)', [userId]);
    await client.query('INSERT INTO profiles (id) VALUES ($1)', [userId]);
  }

  async function newSeededUser(client: PoolClient): Promise<string> {
    const userId = randomUUID();
    await insertProfile(client, userId);
    await client.query('SELECT fn_seed_new_user($1)', [userId]);
    return userId;
  }

  it('T-K01: siembra únicamente la cuenta de sistema — 1 equity "Saldo Inicial", is_system=true', async () => {
    await withRollback(async (client) => {
      const userId = await newSeededUser(client);

      const { rows: equity } = await client.query(
        `SELECT name, is_system FROM accounts WHERE user_id = $1 AND type = 'equity'`,
        [userId],
      );
      expect(equity).toEqual([{ name: 'Saldo Inicial', is_system: true }]);

      const { rows: total } = await client.query(`SELECT count(*)::int AS n FROM accounts WHERE user_id = $1`, [userId]);
      expect(total[0].n).toBe(1);
    });
  });

  it('T-K01b: NO siembra las 7 categorías ni la fuente de ingreso "Sueldo" — afirmado explícitamente, no solo implícito', async () => {
    await withRollback(async (client) => {
      const userId = await newSeededUser(client);

      const { rows: expenses } = await client.query(
        `SELECT count(*)::int AS n FROM accounts WHERE user_id = $1 AND type = 'expense'`,
        [userId],
      );
      expect(expenses[0].n).toBe(0);

      const { rows: income } = await client.query(
        `SELECT count(*)::int AS n FROM accounts WHERE user_id = $1 AND type = 'income'`,
        [userId],
      );
      expect(income[0].n).toBe(0);

      const { rows: sueldo } = await client.query(
        `SELECT count(*)::int AS n FROM accounts WHERE user_id = $1 AND name = 'Sueldo'`,
        [userId],
      );
      expect(sueldo[0].n).toBe(0);
    });
  });

  it('T-K02: 0 cuentas asset, liability o receivable', async () => {
    await withRollback(async (client) => {
      const userId = await newSeededUser(client);
      const { rows } = await client.query(
        `SELECT count(*)::int AS n FROM accounts WHERE user_id = $1 AND type IN ('asset', 'liability', 'receivable')`,
        [userId],
      );
      expect(rows[0].n).toBe(0);
    });
  });

  it('T-K03: invocarla dos veces con el mismo p_user_id no duplica, no lanza; el conteo sigue en 1', async () => {
    await withRollback(async (client) => {
      const userId = randomUUID();
      await insertProfile(client, userId);
      await client.query('SELECT fn_seed_new_user($1)', [userId]);
      await expect(client.query('SELECT fn_seed_new_user($1)', [userId])).resolves.toBeDefined();

      const { rows } = await client.query('SELECT count(*)::int AS n FROM accounts WHERE user_id = $1', [userId]);
      expect(rows[0].n).toBe(1);
    });
  });
});
