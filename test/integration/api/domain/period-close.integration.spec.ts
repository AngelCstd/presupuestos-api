import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { createTestApp, type TestAppHandle } from '../_helpers/app';
import { bearerFor } from '../_helpers/auth';
import { pool, seedFixtureCommitted, type Fixture } from '../_helpers/seed';
import { insertPeriod } from '../../../setup/fixture';
import { insertBudgetEntry, insertBalancedTransaction } from '../../../setup/ledger';
import { expectCents } from '../_helpers/cents';

// Grupo M — cierre de periodo (TASK-api.md §11, T-M01–M15). El más
// delicado de la API: un error aquí produce números plausibles y
// equivocados, no un status distinto. Cada test afirma sobre el estado
// real de `budget_entries`, nunca solo sobre el `200`/`409` de la
// respuesta. BudgetModule no existe todavía — rojo por diseño.
import { BudgetModule } from '../../../../src/budget/budget.module';
import { PrismaQueryRepository } from '../../../../src/shared/queries/repositories/prisma-query.repository';

interface BudgetEntryRow {
  amount_cents: string;
  source: string;
}

describe('BudgetModule — period-close.integration.spec.ts (Grupo M)', () => {
  let app: INestApplication;
  let handle: TestAppHandle;
  let queryRepository: PrismaQueryRepository;
  const prisma = new PrismaClient();

  beforeAll(async () => {
    handle = await createTestApp([BudgetModule]);
    app = handle.app;
    queryRepository = new PrismaQueryRepository(prisma);
  });

  afterAll(async () => {
    await handle.close();
    await prisma.$disconnect();
    await pool.end();
  });

  async function assignBudget(userId: string, periodId: string, categoryId: string, amountCents: number): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await insertBudgetEntry(client, { userId, periodId, categoryId, amountCents });
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async function spendFromCategory(
    userId: string,
    paidFromId: string,
    categoryId: string,
    amountCents: number,
    bookedAt: string,
  ): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await insertBalancedTransaction(client, {
        userId,
        bookedAt,
        entries: [
          { accountId: paidFromId, amountCents: -amountCents },
          { accountId: categoryId, amountCents },
        ],
      });
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async function budgetEntriesFor(userId: string, periodId: string, categoryId: string): Promise<BudgetEntryRow[]> {
    const res = await pool.query(
      `SELECT amount_cents, source FROM budget_entries
       WHERE user_id = $1 AND period_id = $2 AND category_id = $3 AND deleted_at IS NULL`,
      [userId, periodId, categoryId],
    );
    return res.rows as BudgetEntryRow[];
  }

  async function rolloverCount(userId: string): Promise<number> {
    const res = await pool.query(
      `SELECT count(*)::int AS n FROM budget_entries WHERE user_id = $1 AND source = 'rollover' AND deleted_at IS NULL`,
      [userId],
    );
    return res.rows[0].n as number;
  }

  async function closePeriodDirect(id: string): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE budget_periods SET closed_at = now() WHERE id = $1', [id]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async function softDeletePeriod(id: string): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE budget_periods SET deleted_at = now() WHERE id = $1', [id]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  describe('T-M01/T-M02/T-M05/T-M06 — escenario base compartido: Comida (reset) y Servicios (accumulate)', () => {
    let f: Fixture['a'];
    let auth: string;
    let closeRes: request.Response;

    beforeAll(async () => {
      const fixture = await seedFixtureCommitted();
      f = fixture.a;
      auth = bearerFor(f.userId);

      // Servicios (accumulate): asignado 200000, gastado 50000 → +150000
      await assignBudget(f.userId, f.periods.p1, f.accounts.servicios, 200_000);
      await spendFromCategory(f.userId, f.accounts.tdc, f.accounts.servicios, 50_000, '2026-08-05');

      // Comida (reset): asignado 200000, gastado 50000 → +150000
      await assignBudget(f.userId, f.periods.p1, f.accounts.comida, 200_000);
      await spendFromCategory(f.userId, f.accounts.tdc, f.accounts.comida, 50_000, '2026-08-05');

      // Transporte (reset, T-M05): asignado 50000, gastado 50000 → 0
      await assignBudget(f.userId, f.periods.p1, f.accounts.transporte, 50_000);
      await spendFromCategory(f.userId, f.accounts.tdc, f.accounts.transporte, 50_000, '2026-08-06');

      // Salud (accumulate, T-M06): sin asignación, sin gasto — se deja intacta.

      closeRes = await request(app.getHttpServer())
        .post(`/api/v1/periods/${f.periods.p1}/close`)
        .set('Authorization', auth)
        .expect(200);
    });

    it('T-M01: Servicios (accumulate) con sobrante +150000 → budget_entry rollover +150000 en P2; P1.closedAt no nulo', async () => {
      expect(closeRes.body.period.closedAt).not.toBeNull();
      expect(closeRes.body.carriedForward).toEqual([
        expect.objectContaining({ categoryId: f.accounts.servicios, amountCents: '150000' }),
      ]);

      const rows = await budgetEntriesFor(f.userId, f.periods.p2, f.accounts.servicios);
      expect(rows).toHaveLength(1);
      expectCents(rows[0].amount_cents, 150000);
      expect(rows[0].source).toBe('rollover');
    });

    it('T-M02: Comida (reset) con sobrante +150000 → se libera, NO existe rollover de Comida en P2', async () => {
      // Positivo primero: el cierre sí clasificó a Comida como liberada.
      expect(closeRes.body.released).toEqual([
        expect.objectContaining({ categoryId: f.accounts.comida, amountCents: '150000' }),
      ]);

      const rows = await budgetEntriesFor(f.userId, f.periods.p2, f.accounts.comida);
      expect(rows).toHaveLength(0);
    });

    it('T-M05: categoría con available=0 (Transporte) → cero entries de rollover', async () => {
      // Positivo primero: el cierre sí generó AL MENOS un rollover real
      // (Servicios) — si no, "cero para Transporte" sería vacuo.
      expect(closeRes.body.carriedForward.length).toBeGreaterThan(0);

      const rows = await budgetEntriesFor(f.userId, f.periods.p2, f.accounts.transporte);
      expect(rows).toHaveLength(0);
    });

    it('T-M06: categoría sin presupuesto ni gasto (Salud) → cero entries de rollover', async () => {
      expect(closeRes.body.carriedForward.length).toBeGreaterThan(0);

      const rows = await budgetEntriesFor(f.userId, f.periods.p2, f.accounts.salud);
      expect(rows).toHaveLength(0);
    });
  });

  it('T-M03: Comida (reset) con déficit −30000 → existe rollover de −30000 en P2 — el déficit se arrastra aunque sea reset', async () => {
    const fixture = await seedFixtureCommitted();
    const f = fixture.a;
    const auth = bearerFor(f.userId);

    await assignBudget(f.userId, f.periods.p1, f.accounts.comida, 20_000);
    await spendFromCategory(f.userId, f.accounts.tdc, f.accounts.comida, 50_000, '2026-08-05');

    const res = await request(app.getHttpServer())
      .post(`/api/v1/periods/${f.periods.p1}/close`)
      .set('Authorization', auth)
      .expect(200);
    expect(res.body.carriedDeficits).toEqual([
      expect.objectContaining({ categoryId: f.accounts.comida, amountCents: '-30000' }),
    ]);

    const rows = await budgetEntriesFor(f.userId, f.periods.p2, f.accounts.comida);
    expect(rows).toHaveLength(1);
    expectCents(rows[0].amount_cents, -30000);
    expect(rows[0].source).toBe('rollover');
  });

  it('T-M04: Servicios (accumulate) con déficit −30000 → existe rollover de −30000 en P2', async () => {
    const fixture = await seedFixtureCommitted();
    const f = fixture.a;
    const auth = bearerFor(f.userId);

    await assignBudget(f.userId, f.periods.p1, f.accounts.servicios, 20_000);
    await spendFromCategory(f.userId, f.accounts.tdc, f.accounts.servicios, 50_000, '2026-08-05');

    const res = await request(app.getHttpServer())
      .post(`/api/v1/periods/${f.periods.p1}/close`)
      .set('Authorization', auth)
      .expect(200);
    expect(res.body.carriedDeficits).toEqual([
      expect.objectContaining({ categoryId: f.accounts.servicios, amountCents: '-30000' }),
    ]);

    const rows = await budgetEntriesFor(f.userId, f.periods.p2, f.accounts.servicios);
    expect(rows).toHaveLength(1);
    expectCents(rows[0].amount_cents, -30000);
    expect(rows[0].source).toBe('rollover');
  });

  it('T-M07 ❌: cerrar dos veces → la segunda 409 PERIOD_ALREADY_CLOSED; cero rollovers duplicados; closedAt sin cambiar', async () => {
    const fixture = await seedFixtureCommitted();
    const f = fixture.a;
    const auth = bearerFor(f.userId);

    await assignBudget(f.userId, f.periods.p1, f.accounts.servicios, 200_000);
    await spendFromCategory(f.userId, f.accounts.tdc, f.accounts.servicios, 50_000, '2026-08-05');

    const first = await request(app.getHttpServer())
      .post(`/api/v1/periods/${f.periods.p1}/close`)
      .set('Authorization', auth)
      .expect(200);
    expect(first.body.period.closedAt).not.toBeNull();

    const closedAtBefore = await pool.query('SELECT closed_at FROM budget_periods WHERE id = $1', [f.periods.p1]);
    expect(closedAtBefore.rows[0].closed_at).not.toBeNull();

    const before = await budgetEntriesFor(f.userId, f.periods.p2, f.accounts.servicios);
    expect(before).toHaveLength(1);

    const second = await request(app.getHttpServer())
      .post(`/api/v1/periods/${f.periods.p1}/close`)
      .set('Authorization', auth)
      .expect(409);
    expect(second.body.code).toBe('PERIOD_ALREADY_CLOSED');

    const closedAtAfter = await pool.query('SELECT closed_at FROM budget_periods WHERE id = $1', [f.periods.p1]);
    expect((closedAtAfter.rows[0].closed_at as Date).getTime()).toBe(
      (closedAtBefore.rows[0].closed_at as Date).getTime(),
    );

    const after = await budgetEntriesFor(f.userId, f.periods.p2, f.accounts.servicios);
    expect(after).toHaveLength(1);
  });

  it('T-M08 ❌: P2 no existe → 409 NEXT_PERIOD_REQUIRED; P1.closedAt sigue nulo; cero rollovers escritos', async () => {
    const fixture = await seedFixtureCommitted();
    const f = fixture.a;
    const auth = bearerFor(f.userId);
    await softDeletePeriod(f.periods.p2);

    await assignBudget(f.userId, f.periods.p1, f.accounts.servicios, 200_000);
    await spendFromCategory(f.userId, f.accounts.tdc, f.accounts.servicios, 50_000, '2026-08-05');

    // Positivo primero: la asignación manual sí quedó escrita.
    const manualBefore = await pool.query(
      `SELECT count(*)::int AS n FROM budget_entries WHERE user_id = $1 AND source = 'manual'`,
      [f.userId],
    );
    expect(manualBefore.rows[0].n).toBe(1);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/periods/${f.periods.p1}/close`)
      .set('Authorization', auth)
      .expect(409);
    expect(res.body.code).toBe('NEXT_PERIOD_REQUIRED');

    const row = await pool.query('SELECT closed_at FROM budget_periods WHERE id = $1', [f.periods.p1]);
    expect(row.rows[0].closed_at).toBeNull();
    expect(await rolloverCount(f.userId)).toBe(0);
  });

  it('T-M09 ❌: P2 está cerrado → 409 NEXT_PERIOD_CLOSED; P1 sin cerrar; cero rollovers escritos', async () => {
    const fixture = await seedFixtureCommitted();
    const f = fixture.a;
    const auth = bearerFor(f.userId);
    await closePeriodDirect(f.periods.p2);

    await assignBudget(f.userId, f.periods.p1, f.accounts.servicios, 200_000);
    await spendFromCategory(f.userId, f.accounts.tdc, f.accounts.servicios, 50_000, '2026-08-05');

    const res = await request(app.getHttpServer())
      .post(`/api/v1/periods/${f.periods.p1}/close`)
      .set('Authorization', auth)
      .expect(409);
    expect(res.body.code).toBe('NEXT_PERIOD_CLOSED');

    const row = await pool.query('SELECT closed_at FROM budget_periods WHERE id = $1', [f.periods.p1]);
    expect(row.rows[0].closed_at).toBeNull();
    expect(await rolloverCount(f.userId)).toBe(0);
  });

  it('T-M10 ❌: cerrar P2 existiendo P1 abierto → 409 EARLIER_PERIOD_OPEN (S-R8)', async () => {
    const fixture = await seedFixtureCommitted();
    const f = fixture.a;
    const auth = bearerFor(f.userId);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/periods/${f.periods.p2}/close`)
      .set('Authorization', auth)
      .expect(409);
    expect(res.body.code).toBe('EARLIER_PERIOD_OPEN');

    const row = await pool.query('SELECT closed_at FROM budget_periods WHERE id = $1', [f.periods.p2]);
    expect(row.rows[0].closed_at).toBeNull();
  });

  it('T-M11: hueco entre P1 (1–15) y P3 (20–31), sin P2 contiguo → el rollover se materializa en P3', async () => {
    const fixture = await seedFixtureCommitted();
    const f = fixture.a;
    const auth = bearerFor(f.userId);
    await softDeletePeriod(f.periods.p1);
    await softDeletePeriod(f.periods.p2);

    const p1Id = randomUUID();
    const p3Id = randomUUID();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await insertPeriod(client, { id: p1Id, userId: f.userId, startsOn: '2026-01-01', endsOn: '2026-01-15' });
      await insertPeriod(client, { id: p3Id, userId: f.userId, startsOn: '2026-01-20', endsOn: '2026-01-31' });
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    await assignBudget(f.userId, p1Id, f.accounts.servicios, 200_000);
    await spendFromCategory(f.userId, f.accounts.tdc, f.accounts.servicios, 50_000, '2026-01-05');

    const res = await request(app.getHttpServer())
      .post(`/api/v1/periods/${p1Id}/close`)
      .set('Authorization', auth)
      .expect(200);
    expect(res.body.nextPeriodId).toBe(p3Id);

    const rows = await budgetEntriesFor(f.userId, p3Id, f.accounts.servicios);
    expect(rows).toHaveLength(1);
    expectCents(rows[0].amount_cents, 150000);
  });

  it('T-M12: GET /periods/{id}/close-preview con sobrante (accumulate) y déficit → canClose:true, blockers:[], cero escrituras', async () => {
    const fixture = await seedFixtureCommitted();
    const f = fixture.a;
    const auth = bearerFor(f.userId);

    await assignBudget(f.userId, f.periods.p1, f.accounts.servicios, 200_000);
    await spendFromCategory(f.userId, f.accounts.tdc, f.accounts.servicios, 50_000, '2026-08-05');
    await assignBudget(f.userId, f.periods.p1, f.accounts.comida, 20_000);
    await spendFromCategory(f.userId, f.accounts.tdc, f.accounts.comida, 50_000, '2026-08-06');

    const before = await pool.query('SELECT count(*)::int AS n FROM budget_entries WHERE user_id = $1', [f.userId]);

    const res = await request(app.getHttpServer())
      .get(`/api/v1/periods/${f.periods.p1}/close-preview`)
      .set('Authorization', auth)
      .expect(200);

    expect(res.body.nextPeriodId).toBe(f.periods.p2);
    expect(res.body.canClose).toBe(true);
    expect(res.body.blockers).toEqual([]);
    expect(res.body.categories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ categoryId: f.accounts.servicios, action: 'carry_forward', carryCents: '150000' }),
        expect.objectContaining({ categoryId: f.accounts.comida, action: 'carry_deficit', carryCents: '-30000' }),
      ]),
    );

    const after = await pool.query('SELECT count(*)::int AS n FROM budget_entries WHERE user_id = $1', [f.userId]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it('T-M13: close-preview sin P2 → canClose:false, blockers:["NEXT_PERIOD_REQUIRED"]', async () => {
    const fixture = await seedFixtureCommitted();
    const f = fixture.a;
    const auth = bearerFor(f.userId);
    await softDeletePeriod(f.periods.p2);

    const res = await request(app.getHttpServer())
      .get(`/api/v1/periods/${f.periods.p1}/close-preview`)
      .set('Authorization', auth)
      .expect(200);
    expect(res.body.canClose).toBe(false);
    expect(res.body.blockers).toContain('NEXT_PERIOD_REQUIRED');
  });

  it('T-M14: tras cerrar P1, unassignedFunds (F3) libera lo comprometido de P1 y cuenta el rollover en P2 — sin doble conteo (Fallo A)', async () => {
    const fixture = await seedFixtureCommitted();
    const f = fixture.a;
    const auth = bearerFor(f.userId);

    // Ejemplo canónico de ARCHITECTURE.md §3.9 / T-OC05, reusado tal
    // cual: cash 1,000,000; Comida (reset) asignado 200,000 gastado
    // 50,000 → +150,000; Salud (accumulate) gastado 30,000 sin
    // presupuesto → −30,000. unassignedFunds baseline = 740,000n.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await insertBalancedTransaction(client, {
        userId: f.userId,
        bookedAt: '2026-08-05',
        entries: [
          { accountId: f.accounts.nu, amountCents: 1_000_000 },
          { accountId: f.accounts.sueldo, amountCents: -1_000_000 },
        ],
      });
      await insertBudgetEntry(client, {
        userId: f.userId,
        periodId: f.periods.p1,
        categoryId: f.accounts.comida,
        amountCents: 200_000,
      });
      await insertBalancedTransaction(client, {
        userId: f.userId,
        bookedAt: '2026-08-05',
        entries: [
          { accountId: f.accounts.nu, amountCents: -50_000 },
          { accountId: f.accounts.comida, amountCents: 50_000 },
        ],
      });
      await insertBalancedTransaction(client, {
        userId: f.userId,
        bookedAt: '2026-08-06',
        entries: [
          { accountId: f.accounts.nu, amountCents: -30_000 },
          { accountId: f.accounts.salud, amountCents: 30_000 },
        ],
      });
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    const before = await queryRepository.unassignedFunds(f.userId);
    expect(before).toBe(740_000n);

    const closeRes = await request(app.getHttpServer())
      .post(`/api/v1/periods/${f.periods.p1}/close`)
      .set('Authorization', auth)
      .expect(200);
    expect(closeRes.body.period.closedAt).not.toBeNull();

    // Comida (reset, sobrante +150000) se libera → +150000 de vuelta a
    // "sin asignar". Salud (déficit −30000) se arrastra a P2 como
    // rollover → sigue comprometido, sin cambio neto. dinero_real no se
    // mueve al cerrar. El único cambio esperado es +150000, ni más
    // (doble conteo) ni menos (dinero perdido).
    const after = await queryRepository.unassignedFunds(f.userId);
    expect(after).toBe(890_000n);
    expect(after - before).toBe(150_000n);
  });

  it('T-M15 ❌: cierre que falla por NEXT_PERIOD_REQUIRED con sobrantes y déficits reales → 409, cero budget_entries de rollover en cualquier periodo, closedAt sigue nulo', async () => {
    const fixture = await seedFixtureCommitted();
    const f = fixture.a;
    const auth = bearerFor(f.userId);
    await softDeletePeriod(f.periods.p2);

    // Sobrante real (Servicios, accumulate) y déficit real (Comida,
    // reset) — ambos habrían generado un rollover si el cierre hubiera
    // podido completarse. La prueba real de atomicidad es que ninguno de
    // los dos se materialice pese a que los datos para hacerlo sí existen.
    await assignBudget(f.userId, f.periods.p1, f.accounts.servicios, 200_000);
    await spendFromCategory(f.userId, f.accounts.tdc, f.accounts.servicios, 50_000, '2026-08-05');
    await assignBudget(f.userId, f.periods.p1, f.accounts.comida, 20_000);
    await spendFromCategory(f.userId, f.accounts.tdc, f.accounts.comida, 50_000, '2026-08-06');

    const manualBefore = await pool.query(
      `SELECT count(*)::int AS n FROM budget_entries WHERE user_id = $1 AND source = 'manual'`,
      [f.userId],
    );
    expect(manualBefore.rows[0].n).toBe(2);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/periods/${f.periods.p1}/close`)
      .set('Authorization', auth)
      .expect(409);
    expect(res.body.code).toBe('NEXT_PERIOD_REQUIRED');

    const row = await pool.query('SELECT closed_at FROM budget_periods WHERE id = $1', [f.periods.p1]);
    expect(row.rows[0].closed_at).toBeNull();
    expect(await rolloverCount(f.userId)).toBe(0);
  });
});
