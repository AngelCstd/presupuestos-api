import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { createTestApp, type TestAppHandle } from '../_helpers/app';
import { bearerFor } from '../_helpers/auth';
import { pool, seedFixtureCommitted, type Fixture } from '../_helpers/seed';
import { insertAccount } from '../../../setup/fixture';
import { expectRejection, countBudgetEntriesSql } from '../_helpers/reject';

// Grupo L — asignaciones (TASK-api.md §11, T-L01–L13). BudgetModule no
// existe todavía — rojo por diseño.
import { BudgetModule } from '../../../../src/budget/budget.module';
import { PrismaQueryRepository } from '../../../../src/shared/queries/repositories/prisma-query.repository';

describe('BudgetModule — allocations.integration.spec.ts (Grupo L)', () => {
  let app: INestApplication;
  let handle: TestAppHandle;
  let fixture: Fixture;
  let authA: string;
  let queryRepository: PrismaQueryRepository;
  const prisma = new PrismaClient();

  beforeAll(async () => {
    fixture = await seedFixtureCommitted();
    authA = bearerFor(fixture.a.userId);

    handle = await createTestApp([BudgetModule]);
    app = handle.app;
    queryRepository = new PrismaQueryRepository(prisma);
  });

  afterAll(async () => {
    await handle.close();
    await prisma.$disconnect();
    await pool.end();
  });

  async function newCategory(userId: string, name: string, rolloverType = 'reset'): Promise<string> {
    const id = randomUUID();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await insertAccount(client, { id, userId, name, type: 'expense', rolloverType });
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    return id;
  }

  async function newClosedPeriod(userId: string, startsOn: string, endsOn: string): Promise<string> {
    const id = randomUUID();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO budget_periods (id, user_id, starts_on, ends_on, closed_at) VALUES ($1, $2, $3, $4, now())`,
        [id, userId, startsOn, endsOn],
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    return id;
  }

  function post(path: string, auth: string, body: Record<string, unknown>) {
    return request(app.getHttpServer()).post(path).set('Authorization', auth).send(body);
  }

  it('T-L01: POST /periods/{id}/allocations {Comida,"200000"} → 201; source:"manual"', async () => {
    const categoryId = await newCategory(fixture.a.userId, 'Comida L01');
    const res = await post(`/api/v1/periods/${fixture.a.periods.p1}/allocations`, authA, {
      categoryId,
      amountCents: '200000',
    }).expect(201);
    expect(res.body.source).toBe('manual');
    expect(res.body.amountCents).toBe('200000');
    expect(res.body.categoryId).toBe(categoryId);
  });

  it('T-L02: segundo POST {Comida,"-50000"} → 201; assignedCents de F2 = "150000"', async () => {
    const categoryId = await newCategory(fixture.a.userId, 'Comida L02');
    await post(`/api/v1/periods/${fixture.a.periods.p1}/allocations`, authA, {
      categoryId,
      amountCents: '200000',
    }).expect(201);
    await post(`/api/v1/periods/${fixture.a.periods.p1}/allocations`, authA, {
      categoryId,
      amountCents: '-50000',
    }).expect(201);

    const balances = await queryRepository.categoryBalances(fixture.a.userId, fixture.a.periods.p1);
    expect(balances.find((c) => c.categoryId === categoryId)?.assignedCents).toBe(150000n);
  });

  it('T-L03 ❌: POST {Comida,"0"} → 400 VALIDATION_FAILED', async () => {
    const categoryId = await newCategory(fixture.a.userId, 'Comida L03');
    const res = await post(`/api/v1/periods/${fixture.a.periods.p1}/allocations`, authA, {
      categoryId,
      amountCents: '0',
    }).expect(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
  });

  it('T-L04 ❌: POST con categoryId de una cuenta asset → 422 INVALID_BUDGET_CATEGORY', async () => {
    const res = await post(`/api/v1/periods/${fixture.a.periods.p1}/allocations`, authA, {
      categoryId: fixture.a.accounts.nu,
      amountCents: '10000',
    }).expect(422);
    expect(res.body.code).toBe('INVALID_BUDGET_CATEGORY');
  });

  it('T-L05: PUT /allocations/{categoryId} {target:"500000"} estando en 300000 → 200; un entry de +200000; total 500000', async () => {
    const categoryId = await newCategory(fixture.a.userId, 'Comida L05');
    await post(`/api/v1/periods/${fixture.a.periods.p1}/allocations`, authA, {
      categoryId,
      amountCents: '300000',
    }).expect(201);

    const before = await pool.query(
      'SELECT count(*)::int AS n FROM budget_entries WHERE period_id = $1 AND category_id = $2 AND deleted_at IS NULL',
      [fixture.a.periods.p1, categoryId],
    );

    const res = await request(app.getHttpServer())
      .put(`/api/v1/periods/${fixture.a.periods.p1}/allocations/${categoryId}`)
      .set('Authorization', authA)
      .send({ targetAssignedCents: '500000' })
      .expect(200);
    expect(res.body.assignedCents).toBe('500000');

    const after = await pool.query(
      'SELECT count(*)::int AS n FROM budget_entries WHERE period_id = $1 AND category_id = $2 AND deleted_at IS NULL',
      [fixture.a.periods.p1, categoryId],
    );
    expect(after.rows[0].n).toBe(before.rows[0].n + 1);
  });

  it('T-L06: mismo PUT repetido → 200; cero entries nuevos; el total sigue en 500000', async () => {
    const categoryId = await newCategory(fixture.a.userId, 'Comida L06');
    await post(`/api/v1/periods/${fixture.a.periods.p1}/allocations`, authA, {
      categoryId,
      amountCents: '300000',
    }).expect(201);
    await request(app.getHttpServer())
      .put(`/api/v1/periods/${fixture.a.periods.p1}/allocations/${categoryId}`)
      .set('Authorization', authA)
      .send({ targetAssignedCents: '500000' })
      .expect(200);

    const before = await pool.query(
      'SELECT count(*)::int AS n FROM budget_entries WHERE period_id = $1 AND category_id = $2 AND deleted_at IS NULL',
      [fixture.a.periods.p1, categoryId],
    );

    const res = await request(app.getHttpServer())
      .put(`/api/v1/periods/${fixture.a.periods.p1}/allocations/${categoryId}`)
      .set('Authorization', authA)
      .send({ targetAssignedCents: '500000' })
      .expect(200);
    expect(res.body.assignedCents).toBe('500000');

    const after = await pool.query(
      'SELECT count(*)::int AS n FROM budget_entries WHERE period_id = $1 AND category_id = $2 AND deleted_at IS NULL',
      [fixture.a.periods.p1, categoryId],
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it('T-L07: dos PUT concurrentes con target="500000" desde 300000, Promise.all → el total final es EXACTAMENTE 500000, no 700000', async () => {
    const categoryId = await newCategory(fixture.a.userId, 'Comida L07');
    await post(`/api/v1/periods/${fixture.a.periods.p1}/allocations`, authA, {
      categoryId,
      amountCents: '300000',
    }).expect(201);

    // Dos peticiones HTTP concurrentes, lanzadas dentro de UN SOLO `it()`
    // — cada una dispara su propia conexión del pool de Prisma en el lado
    // del servidor. Escrito con dos `it()` separados nunca competiría de
    // verdad, porque la suite corre con --runInBand.
    const [resA, resB] = await Promise.all([
      request(app.getHttpServer())
        .put(`/api/v1/periods/${fixture.a.periods.p1}/allocations/${categoryId}`)
        .set('Authorization', authA)
        .send({ targetAssignedCents: '500000' }),
      request(app.getHttpServer())
        .put(`/api/v1/periods/${fixture.a.periods.p1}/allocations/${categoryId}`)
        .set('Authorization', authA)
        .send({ targetAssignedCents: '500000' }),
    ]);
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);

    const balances = await queryRepository.categoryBalances(fixture.a.userId, fixture.a.periods.p1);
    expect(balances.find((c) => c.categoryId === categoryId)?.assignedCents).toBe(500000n);
  });

  it('T-L08: POST /allocations/move {Comida→Salud,"30000"} → 200; dos entries; el total asignado del periodo no cambió', async () => {
    const comidaId = await newCategory(fixture.a.userId, 'Comida L08');
    const saludId = await newCategory(fixture.a.userId, 'Salud L08');
    await post(`/api/v1/periods/${fixture.a.periods.p1}/allocations`, authA, {
      categoryId: comidaId,
      amountCents: '100000',
    }).expect(201);
    await post(`/api/v1/periods/${fixture.a.periods.p1}/allocations`, authA, {
      categoryId: saludId,
      amountCents: '50000',
    }).expect(201);

    const balancesBefore = await queryRepository.categoryBalances(fixture.a.userId, fixture.a.periods.p1);
    const totalBefore =
      balancesBefore.find((c) => c.categoryId === comidaId)!.assignedCents +
      balancesBefore.find((c) => c.categoryId === saludId)!.assignedCents;

    await post(`/api/v1/periods/${fixture.a.periods.p1}/allocations/move`, authA, {
      fromCategoryId: comidaId,
      toCategoryId: saludId,
      amountCents: '30000',
    }).expect(200);

    const balances = await queryRepository.categoryBalances(fixture.a.userId, fixture.a.periods.p1);
    expect(balances.find((c) => c.categoryId === comidaId)?.assignedCents).toBe(70000n);
    expect(balances.find((c) => c.categoryId === saludId)?.assignedCents).toBe(80000n);
    const totalAfter =
      balances.find((c) => c.categoryId === comidaId)!.assignedCents +
      balances.find((c) => c.categoryId === saludId)!.assignedCents;
    expect(totalAfter).toBe(totalBefore);
  });

  it('T-L09 ❌: move con from === to → 422 SAME_CATEGORY_MOVE', async () => {
    const categoryId = await newCategory(fixture.a.userId, 'Comida L09');
    const res = await post(`/api/v1/periods/${fixture.a.periods.p1}/allocations/move`, authA, {
      fromCategoryId: categoryId,
      toCategoryId: categoryId,
      amountCents: '10000',
    }).expect(422);
    expect(res.body.code).toBe('SAME_CATEGORY_MOVE');
  });

  it('T-L10 ❌: cualquier escritura de asignación sobre un periodo cerrado → 409 PERIOD_CLOSED, cero filas', async () => {
    const closedPeriodId = await newClosedPeriod(fixture.a.userId, '2020-01-01', '2020-01-15');
    const categoryId = await newCategory(fixture.a.userId, 'Comida L10');

    await expectRejection({
      perform: () =>
        post(`/api/v1/periods/${closedPeriodId}/allocations`, authA, { categoryId, amountCents: '10000' }).expect(
          409,
        ),
      code: 'PERIOD_CLOSED',
      countQueries: [{ sql: countBudgetEntriesSql(), params: [fixture.a.userId] }],
    });
  });

  it('T-L11: DELETE /allocations/{id} en periodo abierto → 204; deletedAt no nulo; F2 deja de contarla', async () => {
    const categoryId = await newCategory(fixture.a.userId, 'Comida L11');
    const created = await post(`/api/v1/periods/${fixture.a.periods.p1}/allocations`, authA, {
      categoryId,
      amountCents: '40000',
    }).expect(201);

    const beforeBalances = await queryRepository.categoryBalances(fixture.a.userId, fixture.a.periods.p1);
    expect(beforeBalances.find((c) => c.categoryId === categoryId)?.assignedCents).toBe(40000n);

    await request(app.getHttpServer())
      .delete(`/api/v1/periods/${fixture.a.periods.p1}/allocations/${created.body.id}`)
      .set('Authorization', authA)
      .expect(204);

    const row = await pool.query('SELECT deleted_at FROM budget_entries WHERE id = $1', [created.body.id]);
    expect(row.rows[0].deleted_at).not.toBeNull();

    const afterBalances = await queryRepository.categoryBalances(fixture.a.userId, fixture.a.periods.p1);
    expect(afterBalances.find((c) => c.categoryId === categoryId)?.assignedCents ?? 0n).toBe(0n);
  });

  it('T-L12 ❌: DELETE /allocations/{id} en periodo cerrado → 409 PERIOD_CLOSED', async () => {
    // R11 bloquea el INSERT de un budget_entry en un periodo YA cerrado,
    // no solo su UPDATE/DELETE — la asignación tiene que crearse mientras
    // el periodo sigue abierto, y el periodo se cierra después, aparte.
    const periodId = randomUUID();
    const categoryId = randomUUID();
    const allocationId = randomUUID();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO budget_periods (id, user_id, starts_on, ends_on) VALUES ($1, $2, '2020-02-01', '2020-02-15')`,
        [periodId, fixture.a.userId],
      );
      await insertAccount(client, {
        id: categoryId,
        userId: fixture.a.userId,
        name: 'Comida L12',
        type: 'expense',
        rolloverType: 'reset',
      });
      await client.query(
        `INSERT INTO budget_entries (id, user_id, period_id, category_id, amount_cents, source) VALUES ($1, $2, $3, $4, $5, 'manual')`,
        [allocationId, fixture.a.userId, periodId, categoryId, 10000],
      );
      await client.query('UPDATE budget_periods SET closed_at = now() WHERE id = $1', [periodId]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    const res = await request(app.getHttpServer())
      .delete(`/api/v1/periods/${periodId}/allocations/${allocationId}`)
      .set('Authorization', authA)
      .expect(409);
    expect(res.body.code).toBe('PERIOD_CLOSED');

    const row = await pool.query('SELECT deleted_at FROM budget_entries WHERE id = $1', [allocationId]);
    expect(row.rows[0].deleted_at).toBeNull();
  });

  it('T-L13 ❌: DELETE de una asignación de U2 → 404 ALLOCATION_NOT_FOUND', async () => {
    const categoryId = randomUUID();
    const allocationId = randomUUID();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await insertAccount(client, {
        id: categoryId,
        userId: fixture.b.userId,
        name: 'Comida L13 (U2)',
        type: 'expense',
        rolloverType: 'reset',
      });
      await client.query(
        `INSERT INTO budget_entries (id, user_id, period_id, category_id, amount_cents, source) VALUES ($1, $2, $3, $4, $5, 'manual')`,
        [allocationId, fixture.b.userId, fixture.b.periods.p1, categoryId, 10000],
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    const res = await request(app.getHttpServer())
      .delete(`/api/v1/periods/${fixture.b.periods.p1}/allocations/${allocationId}`)
      .set('Authorization', authA)
      .expect(404);
    expect(res.body.code).toBe('ALLOCATION_NOT_FOUND');
  });
});
