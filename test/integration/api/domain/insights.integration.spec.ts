import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { createTestApp, type TestAppHandle } from '../_helpers/app';
import { bearerFor } from '../_helpers/auth';
import { pool, seedFixtureCommitted } from '../_helpers/seed';
import { insertAccount, insertPeriod } from '../../../setup/fixture';
import { insertBudgetEntry, insertBalancedTransaction } from '../../../setup/ledger';
import { todayInMexicoCity, addDays } from '../_helpers/periods';

// Grupo O — insights (TASK-api.md §11, T-O01–O15). InsightsModule no
// existe todavía — rojo por diseño. AccountsModule sí existe (loop 1) —
// T-O03/T-O15 lo necesitan real.
import { InsightsModule } from '../../../../src/insights/insights.module';
import { AccountsModule } from '../../../../src/accounts/accounts.module';

async function commitSetup(fn: (client: PoolClient) => Promise<void>): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await fn(client);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

describe('InsightsModule — insights.integration.spec.ts (Grupo O)', () => {
  let app: INestApplication;
  let handle: TestAppHandle;

  beforeAll(async () => {
    handle = await createTestApp([InsightsModule, AccountsModule]);
    app = handle.app;
  });

  afterAll(async () => {
    await handle.close();
    await pool.end();
  });

  it('T-O01: tras un saldo inicial (Nu/TDC/Efectivo) → account-balances refleja los tres; equity no aparece', async () => {
    const fixture = await seedFixtureCommitted();
    const f = fixture.a;
    const auth = bearerFor(f.userId);

    const nu = randomUUID();
    const tdc = randomUUID();
    const efectivo = randomUUID();
    await commitSetup(async (client) => {
      await insertAccount(client, { id: nu, userId: f.userId, name: 'Nu O01', type: 'asset' });
      await insertAccount(client, { id: tdc, userId: f.userId, name: 'TDC O01', type: 'liability' });
      await insertAccount(client, { id: efectivo, userId: f.userId, name: 'Efectivo O01', type: 'asset' });
      // Mismos entries que produciría POST /transactions/opening-balances
      // para {Nu:+1000000, TDC:-250000, Efectivo:+80000} — TransactionsModule
      // (A07) no existe todavía, así que se siembra el ledger balanceado
      // directamente; el resultado sobre `entries` es idéntico.
      await insertBalancedTransaction(client, {
        userId: f.userId,
        bookedAt: '2026-07-14',
        entries: [
          { accountId: nu, amountCents: 1_000_000 },
          { accountId: tdc, amountCents: -250_000 },
          { accountId: efectivo, amountCents: 80_000 },
          { accountId: f.accounts.saldoInicial, amountCents: -830_000 },
        ],
      });
    });

    const res = await request(app.getHttpServer()).get('/api/v1/insights/account-balances').set('Authorization', auth).expect(200);
    const byId = new Map((res.body.accounts as Array<{ accountId: string; balanceCents: string }>).map((a) => [a.accountId, a.balanceCents]));
    expect(byId.get(nu)).toBe('1000000');
    expect(byId.get(tdc)).toBe('-250000');
    expect(byId.get(efectivo)).toBe('80000');
    expect(byId.has(f.accounts.saldoInicial)).toBe(false);
  });

  it('T-O02: una cuenta archivada con saldo DISTINTO de cero → sigue apareciendo en account-balances (S-R4)', async () => {
    const fixture = await seedFixtureCommitted();
    const f = fixture.a;
    const auth = bearerFor(f.userId);

    const accountId = randomUUID();
    await commitSetup(async (client) => {
      await insertAccount(client, { id: accountId, userId: f.userId, name: 'Con saldo O02', type: 'asset' });
      await insertBalancedTransaction(client, {
        userId: f.userId,
        bookedAt: '2026-08-05',
        entries: [
          { accountId, amountCents: 12345 },
          { accountId: f.accounts.sueldo, amountCents: -12345 },
        ],
      });
      // Drena a cero para poder archivar (R8 lo exige incluso por SQL
      // directo: es un trigger de base de datos sobre `accounts`, dispara
      // sobre cualquier UPDATE que ponga `archived_at`, sin importar la
      // capa que lo emita — no hay forma de "saltárselo" con SQL).
      await insertBalancedTransaction(client, {
        userId: f.userId,
        bookedAt: '2026-08-05',
        entries: [
          { accountId, amountCents: -12345 },
          { accountId: f.accounts.sueldo, amountCents: 12345 },
        ],
      });
    });

    await pool.query('UPDATE accounts SET archived_at = now() WHERE id = $1', [accountId]);

    // Ya archivada: un movimiento directo por SQL sí la deja con saldo
    // distinto de cero — R8 solo dispara en la transición de
    // `archived_at`, no en entries posteriores. Mismo patrón que T-OC02
    // (loop 1, a nivel de repository).
    await commitSetup(async (client) => {
      await insertBalancedTransaction(client, {
        userId: f.userId,
        bookedAt: '2026-08-06',
        entries: [
          { accountId, amountCents: 12345 },
          { accountId: f.accounts.sueldo, amountCents: -12345 },
        ],
      });
    });

    const res = await request(app.getHttpServer()).get('/api/v1/insights/account-balances').set('Authorization', auth).expect(200);
    const row = (res.body.accounts as Array<{ accountId: string; balanceCents: string }>).find((a) => a.accountId === accountId);
    expect(row).toBeDefined();
    expect(row!.balanceCents).toBe('12345');
  });

  it('T-O03: cuenta recién creada sin movimientos → aparece con "0", no desaparece (LEFT JOIN de F1)', async () => {
    const fixture = await seedFixtureCommitted();
    const auth = bearerFor(fixture.a.userId);

    const createRes = await request(app.getHttpServer())
      .post('/api/v1/accounts')
      .set('Authorization', auth)
      .send({ name: 'Nueva sin movimientos O03', kind: 'cash' })
      .expect(201);

    const res = await request(app.getHttpServer()).get('/api/v1/insights/account-balances').set('Authorization', auth).expect(200);
    const row = (res.body.accounts as Array<{ accountId: string; balanceCents: string }>).find(
      (a) => a.accountId === createRes.body.id,
    );
    expect(row).toBeDefined();
    expect(row!.balanceCents).toBe('0');
  });

  it('T-O04: escenario canónico #1 de §3.9 → unassignedFunds = "740000"', async () => {
    const fixture = await seedFixtureCommitted();
    const f = fixture.a;
    const auth = bearerFor(f.userId);

    await commitSetup(async (client) => {
      await insertBalancedTransaction(client, {
        userId: f.userId,
        bookedAt: '2026-08-05',
        entries: [
          { accountId: f.accounts.nu, amountCents: 1_000_000 },
          { accountId: f.accounts.sueldo, amountCents: -1_000_000 },
        ],
      });
      await insertBudgetEntry(client, { userId: f.userId, periodId: f.periods.p1, categoryId: f.accounts.comida, amountCents: 200_000 });
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
    });

    const res = await request(app.getHttpServer()).get('/api/v1/insights/unassigned-funds').set('Authorization', auth).expect(200);
    expect(res.body.unassignedCents).toBe('740000');
  });

  it('T-O05: dos periodos abiertos (el anterior 1800 comprometido, el nuevo 1000, cash 1420000) → "1140000" — ambos cuentan', async () => {
    const fixture = await seedFixtureCommitted();
    const f = fixture.a;
    const auth = bearerFor(f.userId);

    await commitSetup(async (client) => {
      await insertBalancedTransaction(client, {
        userId: f.userId,
        bookedAt: '2026-08-05',
        entries: [
          { accountId: f.accounts.nu, amountCents: 1_000_000 },
          { accountId: f.accounts.sueldo, amountCents: -1_000_000 },
        ],
      });
      await insertBudgetEntry(client, { userId: f.userId, periodId: f.periods.p1, categoryId: f.accounts.comida, amountCents: 200_000 });
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
      // Segundo periodo abierto (p2, ya sembrado por el fixture), con
      // ingreso adicional y una segunda asignación — ejemplo canónico #2.
      await insertBalancedTransaction(client, {
        userId: f.userId,
        bookedAt: '2026-08-20',
        entries: [
          { accountId: f.accounts.nu, amountCents: 500_000 },
          { accountId: f.accounts.sueldo, amountCents: -500_000 },
        ],
      });
      await insertBudgetEntry(client, { userId: f.userId, periodId: f.periods.p2, categoryId: f.accounts.comida, amountCents: 100_000 });
    });

    const res = await request(app.getHttpServer()).get('/api/v1/insights/unassigned-funds').set('Authorization', auth).expect(200);
    expect(res.body.unassignedCents).toBe('1140000');
  });

  it('T-O06: usuario recién creado, sin nada → "0" (una fila, no cero filas)', async () => {
    const fixture = await seedFixtureCommitted();
    const auth = bearerFor(fixture.a.userId);

    const res = await request(app.getHttpServer()).get('/api/v1/insights/unassigned-funds').set('Authorization', auth).expect(200);
    expect(res.body).toEqual({ unassignedCents: '0' });
  });

  it('T-O07: category-balances?periodId=P1 → todos los sobres, incluidos los que no tienen ni asignación ni gasto', async () => {
    const fixture = await seedFixtureCommitted();
    const f = fixture.a;
    const auth = bearerFor(f.userId);

    const res = await request(app.getHttpServer())
      .get(`/api/v1/insights/category-balances?periodId=${f.periods.p1}`)
      .set('Authorization', auth)
      .expect(200);
    expect(res.body.periodId).toBe(f.periods.p1);
    const ids = (res.body.categories as Array<{ categoryId: string }>).map((c) => c.categoryId);
    // Las 7 categorías sembradas por default (§3.12), ninguna tocada.
    expect(ids).toEqual(
      expect.arrayContaining([
        f.accounts.comida,
        f.accounts.transporte,
        f.accounts.servicios,
        f.accounts.hogar,
        f.accounts.salud,
        f.accounts.personal,
        f.accounts.ahorro,
      ]),
    );
  });

  it('T-O08 ❌: category-balances sin periodId → 400 VALIDATION_FAILED', async () => {
    const fixture = await seedFixtureCommitted();
    const auth = bearerFor(fixture.a.userId);

    const res = await request(app.getHttpServer()).get('/api/v1/insights/category-balances').set('Authorization', auth).expect(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
  });

  it('T-O09 ❌: category-balances con un periodId de U2 → 404 PERIOD_NOT_FOUND', async () => {
    const fixture = await seedFixtureCommitted();
    const authA = bearerFor(fixture.a.userId);

    const res = await request(app.getHttpServer())
      .get(`/api/v1/insights/category-balances?periodId=${fixture.b.periods.p1}`)
      .set('Authorization', authA)
      .expect(404);
    expect(res.body.code).toBe('PERIOD_NOT_FOUND');
  });

  it('T-O10: transacciones en un hueco entre periodos → aparecen en unbudgeted-transactions con description', async () => {
    const fixture = await seedFixtureCommitted();
    const f = fixture.a;
    const auth = bearerFor(f.userId);

    let transactionId = '';
    await commitSetup(async (client) => {
      const result = await insertBalancedTransaction(client, {
        userId: f.userId,
        bookedAt: '2026-06-01', // fuera de p1 (ago 1-15) y p2 (ago 16-31)
        description: 'Gasto en hueco O10',
        entries: [
          { accountId: f.accounts.tdc, amountCents: -2000 },
          { accountId: f.accounts.comida, amountCents: 2000 },
        ],
      });
      transactionId = result.transactionId;
    });

    const res = await request(app.getHttpServer()).get('/api/v1/insights/unbudgeted-transactions').set('Authorization', auth).expect(200);
    const row = (res.body.transactions as Array<{ transactionId: string; description: string }>).find(
      (t) => t.transactionId === transactionId,
    );
    expect(row).toBeDefined();
    expect(row!.description).toBe('Gasto en hueco O10');
  });

  it('T-O11: transacción dentro de un periodo CERRADO → NO aparece en unbudgeted-transactions (tiene periodo, aunque cerrado)', async () => {
    const fixture = await seedFixtureCommitted();
    const f = fixture.a;
    const auth = bearerFor(f.userId);

    const closedPeriodId = randomUUID();
    let transactionId = '';
    await commitSetup(async (client) => {
      await client.query(
        `INSERT INTO budget_periods (id, user_id, starts_on, ends_on, closed_at) VALUES ($1, $2, '2020-01-01', '2020-01-31', now())`,
        [closedPeriodId, f.userId],
      );
      const result = await insertBalancedTransaction(client, {
        userId: f.userId,
        bookedAt: '2020-01-15',
        description: 'Gasto en periodo cerrado O11',
        entries: [
          { accountId: f.accounts.tdc, amountCents: -3000 },
          { accountId: f.accounts.comida, amountCents: 3000 },
        ],
      });
      transactionId = result.transactionId;
    });

    // Positivo primero: la transacción sí existe y sí tiene esa fecha.
    const check = await pool.query('SELECT booked_at::text FROM transactions WHERE id = $1', [transactionId]);
    expect(check.rows[0].booked_at).toBe('2020-01-15');

    const res = await request(app.getHttpServer()).get('/api/v1/insights/unbudgeted-transactions').set('Authorization', auth).expect(200);
    expect((res.body.transactions as Array<{ transactionId: string }>).some((t) => t.transactionId === transactionId)).toBe(false);
  });

  it('T-O12: dashboard?periodId=P1 — los cuatro bloques coinciden EXACTAMENTE con los cuatro endpoints individuales', async () => {
    const fixture = await seedFixtureCommitted();
    const f = fixture.a;
    const auth = bearerFor(f.userId);

    await commitSetup(async (client) => {
      await insertBudgetEntry(client, { userId: f.userId, periodId: f.periods.p1, categoryId: f.accounts.comida, amountCents: 90_000 });
      await insertBalancedTransaction(client, {
        userId: f.userId,
        bookedAt: '2026-08-05',
        entries: [
          { accountId: f.accounts.tdc, amountCents: -20_000 },
          { accountId: f.accounts.comida, amountCents: 20_000 },
        ],
      });
    });

    const [accountsRes, unassignedRes, categoriesRes, unbudgetedRes, dashboardRes] = await Promise.all([
      request(app.getHttpServer()).get('/api/v1/insights/account-balances').set('Authorization', auth),
      request(app.getHttpServer()).get('/api/v1/insights/unassigned-funds').set('Authorization', auth),
      request(app.getHttpServer()).get(`/api/v1/insights/category-balances?periodId=${f.periods.p1}`).set('Authorization', auth),
      request(app.getHttpServer()).get('/api/v1/insights/unbudgeted-transactions').set('Authorization', auth),
      request(app.getHttpServer()).get(`/api/v1/insights/dashboard?periodId=${f.periods.p1}`).set('Authorization', auth),
    ]);

    expect(dashboardRes.status).toBe(200);
    expect(dashboardRes.body.accounts).toEqual(accountsRes.body.accounts);
    expect(dashboardRes.body.unassignedCents).toBe(unassignedRes.body.unassignedCents);
    expect(dashboardRes.body.categories).toEqual(categoriesRes.body.categories);
    expect(dashboardRes.body.unbudgetedTransactions).toEqual(unbudgetedRes.body.transactions);
    expect(dashboardRes.body.period.id).toBe(f.periods.p1);
  });

  it('T-O13: dashboard sin periodId, con un periodo que cubre hoy → resuelve el periodo actual por profile.timezone', async () => {
    const fixture = await seedFixtureCommitted();
    const f = fixture.a;
    const auth = bearerFor(f.userId);
    await commitSetup(async (client) => {
      await client.query('UPDATE budget_periods SET deleted_at = now() WHERE user_id = $1 AND deleted_at IS NULL', [f.userId]);
    });

    const today = todayInMexicoCity();
    const currentPeriodId = randomUUID();
    await commitSetup(async (client) => {
      await insertPeriod(client, { id: currentPeriodId, userId: f.userId, startsOn: addDays(today, -3), endsOn: addDays(today, 3) });
    });

    const res = await request(app.getHttpServer()).get('/api/v1/insights/dashboard').set('Authorization', auth).expect(200);
    expect(res.body.period.id).toBe(currentPeriodId);
  });

  it('T-O16: dashboard sin periodId y sin NINGÚN periodo (usuario nuevo) → 200 con period:null y categories:[], no 404', async () => {
    // API-CONTRACT.md §14, línea 1340: "period y categories vienen en
    // null y [] si no hay periodo actual ni periodId". Es el estado de
    // cualquier usuario recién creado (perfil sin periodos todavía) —
    // y la primera llamada que hace la pantalla principal del
    // frontend. `seedUser()` siempre siembra dos periodos por usuario
    // (test/setup/fixture.ts), así que hay que borrarlos a mano para
    // llegar a este estado — a diferencia de T-O13, aquí NO se crea un
    // periodo de reemplazo.
    const fixture = await seedFixtureCommitted();
    const f = fixture.a;
    const auth = bearerFor(f.userId);
    await commitSetup(async (client) => {
      await client.query('UPDATE budget_periods SET deleted_at = now() WHERE user_id = $1 AND deleted_at IS NULL', [f.userId]);
    });

    const res = await request(app.getHttpServer()).get('/api/v1/insights/dashboard').set('Authorization', auth).expect(200);

    expect(res.body.period).toBeNull();
    expect(res.body.categories).toEqual([]);
    // El resto de la respuesta no depende de que exista un periodo —
    // sigue siendo la misma composición de accountBalances/
    // unassignedFunds/unbudgetedTransactions, no un objeto vacío.
    expect(Array.isArray(res.body.accounts)).toBe(true);
    expect(typeof res.body.unassignedCents).toBe('string');
    expect(Array.isArray(res.body.unbudgetedTransactions)).toBe(true);
  });

  it('T-O14: insights.service.ts no tiene aritmética de montos propia — cero "+"/"-"/reduce sobre bigint, solo mapea y compone', () => {
    const source = readFileSync(join(__dirname, '../../../../src/insights/insights.service.ts'), 'utf-8');

    // Positivo primero: el archivo sí existe y sí tiene contenido real
    // (si no, "cero +/-" sería vacuo). El resto de la suite ya obliga a
    // que este archivo exista para que las peticiones HTTP de arriba
    // funcionen — aquí se re-confirma explícitamente para este test.
    expect(source.length).toBeGreaterThan(0);

    expect(source).not.toMatch(/bigint[^;]*[-+]/);
    expect(source).not.toMatch(/\.reduce\(/);
  });

  it('T-O15: cuenta con saldo cero se archiva por HTTP (R8 garantiza éxito) → sigue apareciendo en account-balances antes y después', async () => {
    const fixture = await seedFixtureCommitted();
    const auth = bearerFor(fixture.a.userId);

    const createRes = await request(app.getHttpServer())
      .post('/api/v1/accounts')
      .set('Authorization', auth)
      .send({ name: 'Saldo cero O15', kind: 'cash' })
      .expect(201);
    const accountId = createRes.body.id as string;

    const before = await request(app.getHttpServer()).get('/api/v1/insights/account-balances').set('Authorization', auth).expect(200);
    expect((before.body.accounts as Array<{ accountId: string }>).some((a) => a.accountId === accountId)).toBe(true);

    await request(app.getHttpServer()).post(`/api/v1/accounts/${accountId}/archive`).set('Authorization', auth).expect(200);

    const after = await request(app.getHttpServer()).get('/api/v1/insights/account-balances').set('Authorization', auth).expect(200);
    const row = (after.body.accounts as Array<{ accountId: string; balanceCents: string }>).find((a) => a.accountId === accountId);
    expect(row).toBeDefined();
    expect(row!.balanceCents).toBe('0');
  });
});
