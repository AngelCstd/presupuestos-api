import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { createTestApp, type TestAppHandle } from '../_helpers/app';
import { bearerFor } from '../_helpers/auth';
import { pool, seedFixtureCommitted, type Fixture } from '../_helpers/seed';
import { insertBalancedTransaction, insertBudgetEntry } from '../../../setup/ledger';

// Grupo H — sobres y fuentes de ingreso (TASK-api.md §11, T-H01–H16).
// CategoriesModule no existe todavía — rojo por diseño.
import { CategoriesModule } from '../../../../src/categories/categories.module';

async function commitSetup(fn: (client: PoolClient) => Promise<void>): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await fn(client);
    await client.query('COMMIT');
  } catch (e) {
    // Sin esto, una conexión con una transacción abortada vuelve al pool
    // y el SIGUIENTE test que la tome hereda el "current transaction is
    // aborted" — un fallo en un test contamina a otro que no tiene nada
    // que ver.
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

describe('CategoriesModule — categories.integration.spec.ts (Grupo H)', () => {
  let app: INestApplication;
  let handle: TestAppHandle;
  let fixture: Fixture;
  let authA: string;

  beforeAll(async () => {
    fixture = await seedFixtureCommitted();
    authA = bearerFor(fixture.a.userId);

    handle = await createTestApp([CategoriesModule]);
    app = handle.app;
  });

  afterAll(async () => {
    await handle.close();
    await pool.end();
  });

  it('T-H01: GET /categories en un usuario recién sembrado → 7 sobres, cada uno con su rolloverType', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/categories?pageSize=50').set('Authorization', authA).expect(200);

    expect(res.body.data).toHaveLength(7);
    expect(res.body.data.every((c: { rolloverType: string }) => typeof c.rolloverType === 'string')).toBe(true);
    const byName = Object.fromEntries(res.body.data.map((c: { name: string; rolloverType: string }) => [c.name, c.rolloverType]));
    expect(byName).toMatchObject({
      Comida: 'reset',
      Transporte: 'reset',
      Servicios: 'accumulate',
      Hogar: 'reset',
      Salud: 'accumulate',
      Personal: 'reset',
      Ahorro: 'accumulate',
    });
  });

  it('T-H02: POST /categories {name:"Mascotas",rolloverType:"accumulate"} → 201', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/categories')
      .set('Authorization', authA)
      .send({ name: 'Mascotas', rolloverType: 'accumulate' })
      .expect(201);
    expect(res.body.rolloverType).toBe('accumulate');
  });

  it('T-H03: POST /categories sin rolloverType → 400 VALIDATION_FAILED', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/categories')
      .set('Authorization', authA)
      .send({ name: 'Sin rollover' })
      .expect(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
  });

  it('T-H04: PATCH /categories/{id} {rolloverType:"reset"} → 200, ningún budget_entry se re-materializa', async () => {
    const before = await pool.query('SELECT count(*)::int AS n FROM budget_entries WHERE user_id = $1', [fixture.a.userId]);

    const res = await request(app.getHttpServer())
      .patch(`/api/v1/categories/${fixture.a.accounts.servicios}`)
      .set('Authorization', authA)
      .send({ rolloverType: 'reset' })
      .expect(200);
    expect(res.body.rolloverType).toBe('reset');

    const after = await pool.query('SELECT count(*)::int AS n FROM budget_entries WHERE user_id = $1', [fixture.a.userId]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it('T-H05/T-H06/T-H07: GET /categories?periodId=P1 trae assigned/spent/available/hasBudget correctos', async () => {
    await commitSetup(async (client) => {
      await insertBudgetEntry(client, {
        userId: fixture.a.userId,
        periodId: fixture.a.periods.p1,
        categoryId: fixture.a.accounts.hogar,
        amountCents: 50_000,
      });
      await insertBudgetEntry(client, {
        userId: fixture.a.userId,
        periodId: fixture.a.periods.p1,
        categoryId: fixture.a.accounts.hogar,
        amountCents: -50_000,
      });
    });

    const res = await request(app.getHttpServer())
      .get(`/api/v1/categories?periodId=${fixture.a.periods.p1}&pageSize=50`)
      .set('Authorization', authA)
      .expect(200);

    const hogar = res.body.data.find((c: { id: string }) => c.id === fixture.a.accounts.hogar);
    expect(hogar.period).toMatchObject({ assignedCents: '0', hasBudget: true });

    const personal = res.body.data.find((c: { id: string }) => c.id === fixture.a.accounts.personal);
    expect(personal).toBeDefined();
    expect(personal.period).toMatchObject({ assignedCents: '0', hasBudget: false });
  });

  it('T-H08: sobre archivado a media quincena, con gasto en el periodo — sigue apareciendo con su gasto real (S-R4)', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/v1/categories')
      .set('Authorization', authA)
      .send({ name: 'Archivada a media quincena', rolloverType: 'reset' })
      .expect(201);
    const categoryId = created.body.id;

    await commitSetup(async (client) => {
      await insertBalancedTransaction(client, {
        userId: fixture.a.userId,
        bookedAt: '2026-08-05',
        entries: [
          { accountId: fixture.a.accounts.nu, amountCents: -8000 },
          { accountId: categoryId, amountCents: 8000 },
        ],
      });
    });

    await request(app.getHttpServer()).post(`/api/v1/categories/${categoryId}/archive`).set('Authorization', authA).expect(200);

    const res = await request(app.getHttpServer())
      .get(`/api/v1/categories?periodId=${fixture.a.periods.p1}&includeArchived=true&pageSize=50`)
      .set('Authorization', authA)
      .expect(200);
    const row = res.body.data.find((c: { id: string }) => c.id === categoryId);
    expect(row).toBeDefined();
    expect(row.period.spentCents).toBe('8000');
  });

  it('T-H09: archivar sobre con gasto acumulado y sin asignaciones vigentes → 200 (R8 exime expense)', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/v1/categories')
      .set('Authorization', authA)
      .send({ name: 'Con gasto sin asignación', rolloverType: 'reset' })
      .expect(201);
    const categoryId = created.body.id;

    await commitSetup(async (client) => {
      await insertBalancedTransaction(client, {
        userId: fixture.a.userId,
        bookedAt: '2026-08-05',
        entries: [
          { accountId: fixture.a.accounts.nu, amountCents: -3000 },
          { accountId: categoryId, amountCents: 3000 },
        ],
      });
    });

    const res = await request(app.getHttpServer()).post(`/api/v1/categories/${categoryId}/archive`).set('Authorization', authA).expect(200);
    expect(res.body.archivedAt).not.toBeNull();
  });

  it('T-H10: archivar sobre con una asignación vigente en un periodo ABIERTO → 409 CATEGORY_HAS_ALLOCATIONS (S-R6)', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/v1/categories')
      .set('Authorization', authA)
      .send({ name: 'Con asignación abierta', rolloverType: 'reset' })
      .expect(201);
    const categoryId = created.body.id;

    await commitSetup(async (client) => {
      await insertBudgetEntry(client, {
        userId: fixture.a.userId,
        periodId: fixture.a.periods.p1,
        categoryId,
        amountCents: 20_000,
      });
    });

    const res = await request(app.getHttpServer()).post(`/api/v1/categories/${categoryId}/archive`).set('Authorization', authA).expect(409);
    expect(res.body.code).toBe('CATEGORY_HAS_ALLOCATIONS');
  });

  it('T-H11: archivar sobre cuyas únicas asignaciones están en un periodo CERRADO → 200 (S-R6 solo mira periodos abiertos)', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/v1/categories')
      .set('Authorization', authA)
      .send({ name: 'Con asignación en periodo cerrado', rolloverType: 'reset' })
      .expect(201);
    const categoryId = created.body.id;

    // R11 bloquea INSERT en budget_entries si el periodo YA está cerrado
    // — hay que asignar mientras está abierto y cerrar DESPUÉS, como
    // pasaría de verdad (el cierre es lo que materializa, no al revés).
    const closedPeriodId = randomUUID();
    await pool.query(
      `INSERT INTO budget_periods (id, user_id, starts_on, ends_on) VALUES ($1, $2, '2026-06-01', '2026-06-15')`,
      [closedPeriodId, fixture.a.userId],
    );
    await commitSetup(async (client) => {
      await insertBudgetEntry(client, { userId: fixture.a.userId, periodId: closedPeriodId, categoryId, amountCents: 15_000 });
    });
    await pool.query('UPDATE budget_periods SET closed_at = now() WHERE id = $1', [closedPeriodId]);

    const res = await request(app.getHttpServer()).post(`/api/v1/categories/${categoryId}/archive`).set('Authorization', authA).expect(200);
    expect(res.body.archivedAt).not.toBeNull();
  });

  it('T-H12: GET /income-sources → solo Sueldo, ningún sobre', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/income-sources').set('Authorization', authA).expect(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].name).toBe('Sueldo');
    expect(res.body.data[0].kind).toBe('income_source');
  });

  it('T-H13: POST /income-sources con rolloverType → 400 VALIDATION_FAILED', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/income-sources')
      .set('Authorization', authA)
      .send({ name: 'Freelance', rolloverType: 'reset' })
      .expect(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
  });

  it('T-H14: POST /income-sources con name:"Comida" (ya existe como sobre) → 409 DUPLICATE_ACCOUNT_NAME', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/income-sources')
      .set('Authorization', authA)
      .send({ name: 'Comida' })
      .expect(409);
    expect(res.body.code).toBe('DUPLICATE_ACCOUNT_NAME');
  });

  it('T-H15: GET /categories/{id}/ledger de Comida con 3 gastos → 3 entries, orden bookedAt DESC', async () => {
    await commitSetup(async (client) => {
      for (const [bookedAt, amount] of [
        ['2026-08-01', 1000],
        ['2026-08-05', 2000],
        ['2026-08-03', 3000],
      ] as const) {
        await insertBalancedTransaction(client, {
          userId: fixture.a.userId,
          bookedAt,
          entries: [
            { accountId: fixture.a.accounts.nu, amountCents: -amount },
            { accountId: fixture.a.accounts.comida, amountCents: amount },
          ],
        });
      }
    });

    const res = await request(app.getHttpServer())
      .get(`/api/v1/categories/${fixture.a.accounts.comida}/ledger?limit=100`)
      .set('Authorization', authA)
      .expect(200);

    expect(res.body.data.length).toBeGreaterThanOrEqual(3);
    const dates = res.body.data.map((e: { bookedAt: string }) => e.bookedAt);
    const sorted = [...dates].sort().reverse();
    expect(dates).toEqual(sorted);
  });

  it('T-H16: GET /categories/{id}/ledger con el id de una cuenta asset → 404 CATEGORY_NOT_FOUND', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/categories/${fixture.a.accounts.nu}/ledger`)
      .set('Authorization', authA)
      .expect(404);
    expect(res.body.code).toBe('CATEGORY_NOT_FOUND');
  });
});
