import { randomUUID } from 'node:crypto';
import { pool, closePool, countRows } from '../setup/db';
import { truncateAll } from '../setup/commit-helper';
import { getErrcode } from '../setup/expect-errcode';
import { seedFixture, type Fixture } from '../setup/fixture';

/**
 * §3.5: una violación de unicidad aborta la transacción completa en
 * Postgres, así que la estrategia correcta es `ON CONFLICT DO NOTHING` +
 * re-select, nunca `INSERT` + catch + `SELECT` en la misma transacción
 * (T-H04 documenta por qué). Estos tests necesitan una primera
 * transacción ya comprometida para que la segunda "colisione" con ella,
 * así que el archivo arranca truncado y con el fixture fresco en cada test.
 */
describe('Grupo H — idempotencia (U05)', () => {
  let fixture: Fixture;

  beforeEach(async () => {
    const client = await pool.connect();
    try {
      await truncateAll(client);
      fixture = await seedFixture(client);
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    await closePool();
  });

  async function insertIdempotent(userId: string, idempotencyKey: string | null, bookedAt = '2026-08-05') {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `INSERT INTO transactions (id, user_id, booked_at, description, idempotency_key)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL
         DO NOTHING
         RETURNING id`,
        [randomUUID(), userId, bookedAt, 'idempotente', idempotencyKey],
      );
      let existing: string | undefined;
      if (rows.length === 0 && idempotencyKey !== null) {
        const select = await client.query(
          'SELECT id FROM transactions WHERE user_id = $1 AND idempotency_key = $2',
          [userId, idempotencyKey],
        );
        existing = select.rows[0]?.id;
      }
      await client.query('COMMIT');
      return { insertedId: rows[0]?.id as string | undefined, existing };
    } finally {
      client.release();
    }
  }

  it('T-H01: dos tx del mismo usuario con idempotency_key distinta → ✅ ambas', async () => {
    const a = fixture.a;
    const first = await insertIdempotent(a.userId, randomUUID());
    const second = await insertIdempotent(a.userId, randomUUID());
    expect(first.insertedId).toBeTruthy();
    expect(second.insertedId).toBeTruthy();
    expect(await countRows(pool, 'transactions')).toBe(2);
  });

  it('T-H02: key ya usada → 0 filas del INSERT, la transacción no queda abortada, el SELECT en la misma tx de DB devuelve la original', async () => {
    const a = fixture.a;
    const key = randomUUID();
    const first = await insertIdempotent(a.userId, key);
    expect(first.insertedId).toBeTruthy();

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `INSERT INTO transactions (id, user_id, booked_at, description, idempotency_key)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL
         DO NOTHING
         RETURNING id`,
        [randomUUID(), a.userId, '2026-08-06', 'reintento', key],
      );
      expect(rows).toHaveLength(0);

      // La transacción sigue viva: este SELECT no debe lanzar 25P02.
      const select = await client.query(
        'SELECT id FROM transactions WHERE user_id = $1 AND idempotency_key = $2',
        [a.userId, key],
      );
      expect(select.rows).toHaveLength(1);
      expect(select.rows[0].id).toBe(first.insertedId);

      await client.query('COMMIT');
    } finally {
      client.release();
    }
  });

  it('T-H03: el segundo intento no crea nada — conteo idéntico antes/después, el SELECT devuelve el id de la primera tx', async () => {
    const a = fixture.a;
    const key = randomUUID();
    const first = await insertIdempotent(a.userId, key);

    const before = await countRows(pool, 'transactions');
    const second = await insertIdempotent(a.userId, key);
    const after = await countRows(pool, 'transactions');

    expect(after).toBe(before);
    expect(second.insertedId).toBeUndefined();
    expect(second.existing).toBe(first.insertedId);
  });

  it('T-H04: INSERT plano con key duplicada (sin ON CONFLICT) → ❌ 23505, la tx queda abortada y un SELECT posterior falla con 25P02', async () => {
    const a = fixture.a;
    const key = randomUUID();
    await insertIdempotent(a.userId, key);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      let insertErrcode: string | undefined;
      try {
        await client.query(
          `INSERT INTO transactions (id, user_id, booked_at, description, idempotency_key)
           VALUES ($1, $2, $3, $4, $5)`,
          [randomUUID(), a.userId, '2026-08-06', 'reintento plano', key],
        );
      } catch (err) {
        insertErrcode = getErrcode(err);
      }
      expect(insertErrcode).toBe('23505');

      let selectErrcode: string | undefined;
      try {
        await client.query('SELECT id FROM transactions WHERE user_id = $1 AND idempotency_key = $2', [a.userId, key]);
      } catch (err) {
        selectErrcode = getErrcode(err);
      }
      expect(selectErrcode).toBe('25P02');

      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('T-H05: misma key para A y para B → ✅ ambas (la unicidad es por usuario)', async () => {
    const { a, b } = fixture;
    const key = randomUUID();
    const first = await insertIdempotent(a.userId, key);
    const second = await insertIdempotent(b.userId, key);
    expect(first.insertedId).toBeTruthy();
    expect(second.insertedId).toBeTruthy();
  });

  it('T-H06: tres tx con idempotency_key=NULL → ✅ las tres (índice parcial permite múltiples NULL)', async () => {
    const a = fixture.a;
    await insertIdempotent(a.userId, null);
    await insertIdempotent(a.userId, null);
    await insertIdempotent(a.userId, null);
    expect(await countRows(pool, 'transactions')).toBe(3);
  });
});
