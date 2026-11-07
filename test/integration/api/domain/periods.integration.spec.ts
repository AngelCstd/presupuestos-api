import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { createTestApp, type TestAppHandle } from '../_helpers/app';
import { bearerFor } from '../_helpers/auth';
import { pool, seedFixtureCommitted } from '../_helpers/seed';
import { insertPeriod, insertAccount } from '../../../setup/fixture';
import { insertBudgetEntry, insertBalancedTransaction } from '../../../setup/ledger';
import { todayInMexicoCity, addDays } from '../_helpers/periods';
import { PrismaClient } from '@prisma/client';

// Grupo K — periodos (TASK-api.md §11, T-K01–K14). BudgetModule no existe
// todavía — rojo por diseño, igual que TransactionsModule en la sesión 1.
import { BudgetModule } from '../../../../src/budget/budget.module';
import { PrismaQueryRepository } from '../../../../src/shared/queries/repositories/prisma-query.repository';

async function countPeriods(userId: string): Promise<number> {
  const res = await pool.query('SELECT count(*)::int AS n FROM budget_periods WHERE user_id = $1', [userId]);
  return res.rows[0].n as number;
}

describe('BudgetModule — periods.integration.spec.ts (Grupo K)', () => {
  let app: INestApplication;
  let handle: TestAppHandle;

  beforeAll(async () => {
    handle = await createTestApp([BudgetModule]);
    app = handle.app;
  });

  afterAll(async () => {
    await handle.close();
    await pool.end();
  });

  /**
   * Usuario nuevo, sin los `p1`/`p2` fijos (agosto 2026) que
   * `seedFixtureCommitted()` siembra por default — Grupo K crea sus
   * propios periodos por test y no puede arriesgar un traslape con esos
   * dos contra `budget_periods_no_overlap` (EXCLUDE, mismo problema que
   * documentó la sesión 1 en `_helpers/periods.ts`).
   */
  async function isolatedUser(): Promise<{ userId: string; auth: string }> {
    const fixture = await seedFixtureCommitted();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE budget_periods SET deleted_at = now() WHERE user_id = $1 AND deleted_at IS NULL', [
        fixture.a.userId,
      ]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    return { userId: fixture.a.userId, auth: bearerFor(fixture.a.userId) };
  }

  async function insertRawPeriod(userId: string, startsOn: string, endsOn: string, closedAt?: string): Promise<string> {
    const id = randomUUID();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await insertPeriod(client, { id, userId, startsOn, endsOn, closedAt: closedAt ?? null });
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    return id;
  }

  it('T-K01: POST /periods {startsOn,endsOn} → 201; closedAt:null', async () => {
    const { auth } = await isolatedUser();
    const res = await request(app.getHttpServer())
      .post('/api/v1/periods')
      .set('Authorization', auth)
      .send({ startsOn: '2025-01-01', endsOn: '2025-01-15' })
      .expect(201);
    expect(res.body.closedAt).toBeNull();
    expect(res.body.status).toBe('open');
  });

  it('T-K02 ❌: segundo periodo traslapado → 409 PERIOD_OVERLAP, cero filas nuevas', async () => {
    const { userId, auth } = await isolatedUser();
    await request(app.getHttpServer())
      .post('/api/v1/periods')
      .set('Authorization', auth)
      .send({ startsOn: '2025-01-01', endsOn: '2025-01-15' })
      .expect(201);

    const before = await countPeriods(userId);
    const res = await request(app.getHttpServer())
      .post('/api/v1/periods')
      .set('Authorization', auth)
      .send({ startsOn: '2025-01-10', endsOn: '2025-01-20' })
      .expect(409);
    expect(res.body.code).toBe('PERIOD_OVERLAP');
    expect(await countPeriods(userId)).toBe(before);
  });

  it('T-K03: periodos 1–15 y 20–31 (con hueco) → 201 en ambos, los huecos están permitidos', async () => {
    const { auth } = await isolatedUser();
    await request(app.getHttpServer())
      .post('/api/v1/periods')
      .set('Authorization', auth)
      .send({ startsOn: '2025-02-01', endsOn: '2025-02-15' })
      .expect(201);
    await request(app.getHttpServer())
      .post('/api/v1/periods')
      .set('Authorization', auth)
      .send({ startsOn: '2025-02-20', endsOn: '2025-02-28' })
      .expect(201);
  });

  it('T-K04 ❌: endsOn anterior a startsOn → 400 o 422 (según la implementación), cero filas escritas', async () => {
    const { userId, auth } = await isolatedUser();
    const before = await countPeriods(userId);

    const res = await request(app.getHttpServer())
      .post('/api/v1/periods')
      .set('Authorization', auth)
      .send({ startsOn: '2025-03-15', endsOn: '2025-03-01' });
    expect([400, 422]).toContain(res.status);
    if (res.status === 422) {
      expect(res.body.code).toBe('INVALID_INPUT');
    } else {
      expect(res.body.code).toBe('VALIDATION_FAILED');
    }

    expect(await countPeriods(userId)).toBe(before);
  });

  it('T-K05: GET /periods/current con hoy dentro del rango → 200, el periodo', async () => {
    const { userId, auth } = await isolatedUser();
    const today = todayInMexicoCity();
    const periodId = await insertRawPeriod(userId, addDays(today, -3), addDays(today, 3));

    const res = await request(app.getHttpServer()).get('/api/v1/periods/current').set('Authorization', auth).expect(200);
    expect(res.body.id).toBe(periodId);
  });

  it('T-K06 ❌: GET /periods/current con hoy en un hueco → 404 NO_CURRENT_PERIOD', async () => {
    const { userId, auth } = await isolatedUser();
    const today = todayInMexicoCity();
    // Un periodo que ya terminó y otro que todavía no empieza — hoy cae
    // en el hueco entre los dos, no en ninguno de los dos rangos.
    await insertRawPeriod(userId, addDays(today, -20), addDays(today, -10));
    await insertRawPeriod(userId, addDays(today, 10), addDays(today, 20));

    const res = await request(app.getHttpServer()).get('/api/v1/periods/current').set('Authorization', auth).expect(404);
    expect(res.body.code).toBe('NO_CURRENT_PERIOD');
  });

  it('T-K07: profile.timezone en un huso donde hoy local y hoy UTC caen en días distintos → /periods/current resuelve por la fecha local', async () => {
    const { userId, auth } = await isolatedUser();

    // Pacific/Kiritimati (UTC+14) difiere de UTC siempre que la hora UTC
    // sea >= 10:00 (local ya cruzó a mañana); Pacific/Niue (UTC−11)
    // difiere siempre que la hora UTC sea < 10:00 (local sigue en ayer).
    // Las dos ventanas cubren las 24 horas del día sin hueco — con este
    // corte, SIEMPRE hay una zona que discrimina, sin depender de en qué
    // momento real corra la suite.
    const hourRes = await pool.query("SELECT extract(hour from now() AT TIME ZONE 'UTC')::int AS h");
    const utcHour = hourRes.rows[0].h as number;
    const zone = utcHour < 10 ? 'Pacific/Niue' : 'Pacific/Kiritimati';

    const datesRes = await pool.query(
      `SELECT (now() AT TIME ZONE 'UTC')::date::text AS utc_today, (now() AT TIME ZONE $1)::date::text AS local_today`,
      [zone],
    );
    const { utc_today: utcToday, local_today: localToday } = datesRes.rows[0] as {
      utc_today: string;
      local_today: string;
    };
    // Sanity check — si esto fallara, la elección de zona de arriba está
    // mal, no el Service bajo prueba.
    expect(localToday).not.toBe(utcToday);

    const client = await pool.connect();
    try {
      await client.query('UPDATE profiles SET timezone = $1 WHERE id = $2', [zone, userId]);
    } finally {
      client.release();
    }

    const localPeriodId = await insertRawPeriod(userId, localToday, localToday);
    // Señuelo: un periodo que solo cubre la fecha UTC (garantizado sin
    // traslape, porque localToday !== utcToday). Si el Service usara
    // now()::date de Postgres en vez de profile.timezone, devolvería este.
    const decoyPeriodId = await insertRawPeriod(userId, utcToday, utcToday);

    const res = await request(app.getHttpServer()).get('/api/v1/periods/current').set('Authorization', auth).expect(200);
    expect(res.body.id).toBe(localPeriodId);
    expect(res.body.id).not.toBe(decoyPeriodId);
  });

  it('T-K08: PATCH /periods/{id} con fechas nuevas, periodo abierto → 200', async () => {
    const { userId, auth } = await isolatedUser();
    const periodId = await insertRawPeriod(userId, '2025-04-01', '2025-04-15');

    const res = await request(app.getHttpServer())
      .patch(`/api/v1/periods/${periodId}`)
      .set('Authorization', auth)
      .send({ startsOn: '2025-04-02', endsOn: '2025-04-16' })
      .expect(200);
    expect(res.body.startsOn).toBe('2025-04-02');
    expect(res.body.endsOn).toBe('2025-04-16');
  });

  it('T-K09 ❌: PATCH /periods/{id} con fechas, periodo cerrado → 409 PERIOD_CLOSED, fechas sin cambiar', async () => {
    const { userId, auth } = await isolatedUser();
    const periodId = await insertRawPeriod(userId, '2025-05-01', '2025-05-15', new Date().toISOString());

    const res = await request(app.getHttpServer())
      .patch(`/api/v1/periods/${periodId}`)
      .set('Authorization', auth)
      .send({ startsOn: '2025-05-02', endsOn: '2025-05-16' })
      .expect(409);
    expect(res.body.code).toBe('PERIOD_CLOSED');

    const row = await pool.query('SELECT starts_on::text, ends_on::text FROM budget_periods WHERE id = $1', [
      periodId,
    ]);
    expect(row.rows[0].starts_on).toBe('2025-05-01');
    expect(row.rows[0].ends_on).toBe('2025-05-15');
  });

  it('T-K10: DELETE /periods/{id} sin asignaciones, abierto → 204; deletedAt no nulo, la fila sigue existiendo', async () => {
    const { userId, auth } = await isolatedUser();
    const periodId = await insertRawPeriod(userId, '2025-06-01', '2025-06-15');

    await request(app.getHttpServer()).delete(`/api/v1/periods/${periodId}`).set('Authorization', auth).expect(204);

    const row = await pool.query('SELECT deleted_at FROM budget_periods WHERE id = $1', [periodId]);
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0].deleted_at).not.toBeNull();
  });

  it('T-K11 ❌: DELETE /periods/{id} con una asignación vigente → 409 PERIOD_NOT_EMPTY', async () => {
    const { userId, auth } = await isolatedUser();
    const periodId = await insertRawPeriod(userId, '2025-07-01', '2025-07-15');

    const categoryId = randomUUID();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await insertAccount(client, { id: categoryId, userId, name: 'Comida K11', type: 'expense', rolloverType: 'reset' });
      await insertBudgetEntry(client, { userId, periodId, categoryId, amountCents: 50000 });
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    const res = await request(app.getHttpServer()).delete(`/api/v1/periods/${periodId}`).set('Authorization', auth).expect(409);
    expect(res.body.code).toBe('PERIOD_NOT_EMPTY');

    const row = await pool.query('SELECT deleted_at FROM budget_periods WHERE id = $1', [periodId]);
    expect(row.rows[0].deleted_at).toBeNull();
  });

  it('T-K12 ❌: DELETE /periods/{id} cerrado → 409 PERIOD_CLOSED, no se marcó borrado', async () => {
    const { userId, auth } = await isolatedUser();
    const periodId = await insertRawPeriod(userId, '2025-08-01', '2025-08-15', new Date().toISOString());

    const res = await request(app.getHttpServer()).delete(`/api/v1/periods/${periodId}`).set('Authorization', auth).expect(409);
    expect(res.body.code).toBe('PERIOD_CLOSED');

    const row = await pool.query('SELECT deleted_at FROM budget_periods WHERE id = $1', [periodId]);
    expect(row.rows[0].deleted_at).toBeNull();
  });

  it('T-K13: borrar un periodo con transacciones → 204; esas transacciones aparecen en unbudgeted-transactions (F4)', async () => {
    const { userId, auth } = await isolatedUser();
    const periodId = await insertRawPeriod(userId, '2025-09-01', '2025-09-15');

    const categoryId = randomUUID();
    const assetId = randomUUID();
    const client = await pool.connect();
    let transactionId = '';
    try {
      await client.query('BEGIN');
      await insertAccount(client, { id: categoryId, userId, name: 'Comida K13', type: 'expense', rolloverType: 'reset' });
      await insertAccount(client, { id: assetId, userId, name: 'Nu K13', type: 'asset' });
      const result = await insertBalancedTransaction(client, {
        userId,
        bookedAt: '2025-09-05',
        entries: [
          { accountId: assetId, amountCents: -1000 },
          { accountId: categoryId, amountCents: 1000 },
        ],
      });
      transactionId = result.transactionId;
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    await request(app.getHttpServer()).delete(`/api/v1/periods/${periodId}`).set('Authorization', auth).expect(204);

    const prisma = new PrismaClient();
    try {
      const repo = new PrismaQueryRepository(prisma);
      const orphans = await repo.transactionsWithoutPeriod(userId);
      expect(orphans.some((o) => o.transactionId === transactionId)).toBe(true);
    } finally {
      await prisma.$disconnect();
    }
  });

  it('T-K14: crear un periodo nuevo con el mismo rango que uno borrado → 201 (EXCLUDE con deleted_at IS NULL)', async () => {
    const { userId, auth } = await isolatedUser();
    const periodId = await insertRawPeriod(userId, '2025-10-01', '2025-10-15');
    await request(app.getHttpServer()).delete(`/api/v1/periods/${periodId}`).set('Authorization', auth).expect(204);

    await request(app.getHttpServer())
      .post('/api/v1/periods')
      .set('Authorization', auth)
      .send({ startsOn: '2025-10-01', endsOn: '2025-10-15' })
      .expect(201);
  });
});
