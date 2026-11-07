import { randomUUID } from 'node:crypto';
import { closePool, withRollback } from '../setup/db';
import { expectImmediateRejection } from '../setup/expect-errcode';
import { insertPeriod, seedFixture } from '../setup/fixture';

describe('Grupo E — budget_periods: EXCLUDE sin traslape, R10 (U04, U15)', () => {
  afterAll(async () => {
    await closePool();
  });

  it('T-E01: [08-01,08-15] y [08-16,08-31] para A → ✅ ambos', async () => {
    await withRollback(async (client) => {
      const { a } = await seedFixture(client);
      await insertPeriod(client, { id: randomUUID(), userId: a.userId, startsOn: '2026-09-01', endsOn: '2026-09-15' });
      await insertPeriod(client, { id: randomUUID(), userId: a.userId, startsOn: '2026-09-16', endsOn: '2026-09-30' });
      const { rows } = await client.query(
        'SELECT count(*)::int AS n FROM budget_periods WHERE user_id = $1 AND starts_on >= $2',
        [a.userId, '2026-09-01'],
      );
      expect(rows[0].n).toBe(2);
    });
  });

  it('T-E02: [08-01,08-15] y [08-20,08-31] con hueco → ✅ ambos (sin regla de continuidad)', async () => {
    await withRollback(async (client) => {
      const { a } = await seedFixture(client);
      await insertPeriod(client, { id: randomUUID(), userId: a.userId, startsOn: '2026-09-01', endsOn: '2026-09-15' });
      await insertPeriod(client, { id: randomUUID(), userId: a.userId, startsOn: '2026-09-20', endsOn: '2026-09-30' });
      const { rows } = await client.query(
        'SELECT count(*)::int AS n FROM budget_periods WHERE user_id = $1 AND starts_on >= $2',
        [a.userId, '2026-09-01'],
      );
      expect(rows[0].n).toBe(2);
    });
  });

  it('T-E03: [08-01,08-15] y [08-15,08-31] (tocan en el límite) → ❌ 23P01', async () => {
    await withRollback(async (client) => {
      const { a } = await seedFixture(client);
      await insertPeriod(client, { id: randomUUID(), userId: a.userId, startsOn: '2026-09-01', endsOn: '2026-09-15' });
      await expectImmediateRejection(
        client,
        () => insertPeriod(client, { id: randomUUID(), userId: a.userId, startsOn: '2026-09-15', endsOn: '2026-09-30' }),
        '23P01',
        'budget_periods',
      );
    });
  });

  it('T-E04: [08-01,08-31] y [08-10,08-20] (uno contenido en el otro) → ❌ 23P01', async () => {
    await withRollback(async (client) => {
      const { a } = await seedFixture(client);
      await insertPeriod(client, { id: randomUUID(), userId: a.userId, startsOn: '2026-09-01', endsOn: '2026-09-30' });
      await expectImmediateRejection(
        client,
        () => insertPeriod(client, { id: randomUUID(), userId: a.userId, startsOn: '2026-09-10', endsOn: '2026-09-20' }),
        '23P01',
        'budget_periods',
      );
    });
  });

  it('T-E05: [08-01,08-15] para A y el mismo rango para B → ✅ ambos', async () => {
    await withRollback(async (client) => {
      const { a, b } = await seedFixture(client);
      await insertPeriod(client, { id: randomUUID(), userId: a.userId, startsOn: '2026-09-01', endsOn: '2026-09-15' });
      await insertPeriod(client, { id: randomUUID(), userId: b.userId, startsOn: '2026-09-01', endsOn: '2026-09-15' });
      const { rows } = await client.query(
        'SELECT count(*)::int AS n FROM budget_periods WHERE starts_on = $1',
        ['2026-09-01'],
      );
      expect(rows[0].n).toBe(2);
    });
  });

  it('T-E06: [08-01,08-15] borrado suave, luego [08-10,08-20] en el mismo rango → ✅ éxito (predicado del EXCLUDE)', async () => {
    await withRollback(async (client) => {
      const { a } = await seedFixture(client);
      const deletedId = randomUUID();
      await insertPeriod(client, { id: deletedId, userId: a.userId, startsOn: '2026-09-01', endsOn: '2026-09-15' });
      await client.query('UPDATE budget_periods SET deleted_at = now() WHERE id = $1', [deletedId]);

      await insertPeriod(client, { id: randomUUID(), userId: a.userId, startsOn: '2026-09-10', endsOn: '2026-09-20' });

      const { rows } = await client.query(
        'SELECT count(*)::int AS n FROM budget_periods WHERE user_id = $1 AND starts_on >= $2',
        [a.userId, '2026-09-01'],
      );
      expect(rows[0].n).toBe(2);
    });
  });

  it('T-E07: starts_on=08-15, ends_on=08-01 (rango inválido) → ❌ 23514', async () => {
    await withRollback(async (client) => {
      const { a } = await seedFixture(client);
      await expectImmediateRejection(
        client,
        () => insertPeriod(client, { id: randomUUID(), userId: a.userId, startsOn: '2026-09-15', endsOn: '2026-09-01' }),
        '23514',
        'budget_periods',
      );
    });
  });

  it('T-E08: "periodo siguiente" de [08-01,08-15] con [08-20,08-31] existente → resuelve al segundo, no NULL', async () => {
    await withRollback(async (client) => {
      const { a } = await seedFixture(client);
      const p1 = randomUUID();
      const p2 = randomUUID();
      await insertPeriod(client, { id: p1, userId: a.userId, startsOn: '2026-09-01', endsOn: '2026-09-15' });
      await insertPeriod(client, { id: p2, userId: a.userId, startsOn: '2026-09-20', endsOn: '2026-09-30' });

      // Definición de §3.3: starts_on más pequeño estrictamente mayor al
      // ends_on del periodo que se cierra, no borrado.
      const { rows } = await client.query(
        `SELECT id FROM budget_periods
         WHERE user_id = $1 AND deleted_at IS NULL AND starts_on > (SELECT ends_on FROM budget_periods WHERE id = $2)
         ORDER BY starts_on ASC LIMIT 1`,
        [a.userId, p1],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(p2);
    });
  });

  it('T-E09: UPDATE starts_on en periodo cerrado → ❌ P1010, fechas sin cambio', async () => {
    await withRollback(async (client) => {
      const { a } = await seedFixture(client);
      await client.query('UPDATE budget_periods SET closed_at = now() WHERE id = $1', [a.periods.p1]);

      await expectImmediateRejection(
        client,
        () => client.query('UPDATE budget_periods SET starts_on = $1 WHERE id = $2', ['2026-08-02', a.periods.p1]),
        'P1010',
        'budget_periods',
      );

      const { rows } = await client.query('SELECT starts_on FROM budget_periods WHERE id = $1', [a.periods.p1]);
      expect(rows[0].starts_on.toISOString().slice(0, 10)).toBe('2026-08-01');
    });
  });

  it('T-E10: UPDATE ends_on en periodo cerrado → ❌ P1010', async () => {
    await withRollback(async (client) => {
      const { a } = await seedFixture(client);
      await client.query('UPDATE budget_periods SET closed_at = now() WHERE id = $1', [a.periods.p1]);

      await expectImmediateRejection(
        client,
        () => client.query('UPDATE budget_periods SET ends_on = $1 WHERE id = $2', ['2026-08-20', a.periods.p1]),
        'P1010',
        'budget_periods',
      );
    });
  });

  it('T-E11: UPDATE closed_at = NULL en periodo cerrado (reapertura) → ✅ éxito', async () => {
    await withRollback(async (client) => {
      const { a } = await seedFixture(client);
      await client.query('UPDATE budget_periods SET closed_at = now() WHERE id = $1', [a.periods.p1]);

      await client.query('UPDATE budget_periods SET closed_at = NULL WHERE id = $1', [a.periods.p1]);

      const { rows } = await client.query('SELECT closed_at FROM budget_periods WHERE id = $1', [a.periods.p1]);
      expect(rows[0].closed_at).toBeNull();
    });
  });

  it('T-E12: UPDATE starts_on en periodo abierto → ✅ éxito', async () => {
    await withRollback(async (client) => {
      const { a } = await seedFixture(client);
      await client.query('UPDATE budget_periods SET starts_on = $1 WHERE id = $2', ['2026-08-02', a.periods.p1]);

      const { rows } = await client.query('SELECT starts_on FROM budget_periods WHERE id = $1', [a.periods.p1]);
      expect(rows[0].starts_on.toISOString().slice(0, 10)).toBe('2026-08-02');
    });
  });
});
