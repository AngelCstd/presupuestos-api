import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { createTestApp, type TestAppHandle } from '../_helpers/app';
import { bearerFor } from '../_helpers/auth';
import { pool, seedFixtureCommitted } from '../_helpers/seed';
import { insertBudgetEntry, insertBalancedTransaction } from '../../../setup/ledger';
import { insertAccount } from '../../../setup/fixture';
import { seedLateCapturePeriods } from '../_helpers/periods';
import { todayInTimezone } from '../../../../src/shared/time/today-in-timezone';

// Grupo R — el resto del contrato (TASK-api.md §11, T-R01–04, R09, R11,
// R12). T-R05/R06/R07/R08/R10 ya se cubrieron en loop 1
// (`core/contract-static.integration.spec.ts`) — ese archivo deja dicho
// explícitamente que el resto vive aquí, en loop 2, porque necesita la
// superficie completa de los 7 dominios. Ninguno de los módulos de
// dominio de loop 2 existe todavía — rojo por diseño.
import { TransactionsModule } from '../../../../src/transactions/transactions.module';
import { BudgetModule } from '../../../../src/budget/budget.module';
import { RecurringModule } from '../../../../src/recurring/recurring.module';
import { InsightsModule } from '../../../../src/insights/insights.module';
import { AccountsModule } from '../../../../src/accounts/accounts.module';
import { CategoriesModule } from '../../../../src/categories/categories.module';
import { ProfileModule } from '../../../../src/profile/profile.module';

const FIXTURES_DIR = join(__dirname, '../../../fixtures/contract');
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const TIMESTAMP_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
// "message" y "constraint" son texto libre, explícitamente NO contrato
// (§7.1: "Programa contra `code`, nunca contra `message`... puede
// cambiar de redacción sin aviso") — se normalizan igual que un uuid o
// un timestamp, aunque §11.1 no los mencione por nombre. Comparar esa
// prosa literal contradiría la regla que el propio documento ya fijó.
const MESSAGE_LIKE_KEYS = new Set(['message', 'constraint']);

function normalize(value: unknown, dateKeys: Set<string>): unknown {
  if (Array.isArray(value)) return value.map((v) => normalize(v, dateKeys));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (MESSAGE_LIKE_KEYS.has(k)) {
        out[k] = '<message>';
      } else if (dateKeys.has(k) && typeof v === 'string') {
        out[k] = '<date>';
      } else {
        out[k] = normalize(v, dateKeys);
      }
    }
    return out;
  }
  if (typeof value === 'string') {
    return value.replace(TIMESTAMP_RE, '<timestamp>').replace(UUID_RE, '<uuid>');
  }
  return value;
}

function loadFixture(fixtureFile: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, fixtureFile), 'utf-8'));
}

/**
 * `dateKeys` — campos de fecha inherentemente dinámicos en el escenario
 * de ESTE archivo (p. ej. `nextDueOn` calculado desde "hoy" al crear un
 * template sin confirmar, o el `bookedAt` de una captura tardía atado a
 * periodos relativos a "hoy"). Para esos dos casos puntuales se agrega
 * una tercera categoría de placeholder (`<date>`) más allá de las dos que
 * especifica TASK-api.md §11.1 (uuid/timestamp) — la razón es la misma
 * por la que la sesión 1 dejó de hardcodear fechas para Grupo S: un
 * fixture versionado no puede depender de en qué día real se corra la
 * suite. El resto de los 25 fixtures no usa `dateKeys` y se compara
 * literal, tal como pide el documento.
 */
function expectMatchesFixture(actual: unknown, fixtureFile: string, dateKeys: string[] = []): void {
  const expected = loadFixture(fixtureFile);
  expect(normalize(actual, new Set(dateKeys))).toEqual(expected);
}

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

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTsFiles(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('contract-fixtures.integration.spec.ts (Grupo R — T-R01–04, R09, R11, R12)', () => {
  let app: INestApplication;
  let handle: TestAppHandle;
  const responses: Record<string, unknown> = {};

  beforeAll(async () => {
    handle = await createTestApp([
      TransactionsModule,
      BudgetModule,
      RecurringModule,
      InsightsModule,
      AccountsModule,
      CategoriesModule,
      ProfileModule,
    ]);
    app = handle.app;

    function post(path: string, auth: string, body: Record<string, unknown>, idemKey?: string) {
      const req = request(app.getHttpServer()).post(path).set('Authorization', auth);
      if (idemKey !== undefined) req.set('Idempotency-Key', idemKey);
      return req.send(body);
    }

    // ── Escenario general: cuentas, transacción, asignaciones, periodos,
    //    fuentes de ingreso, recurrentes, dos errores, perfil.
    const gFixture = await seedFixtureCommitted();
    const g = gFixture.a;
    const authG = bearerFor(g.userId);

    // Pristino — antes de crear nada más.
    responses['accounts.list.json'] = (
      await request(app.getHttpServer()).get('/api/v1/accounts').set('Authorization', authG).expect(200)
    ).body;

    responses['accounts.create.json'] = (
      await request(app.getHttpServer())
        .post('/api/v1/accounts')
        .set('Authorization', authG)
        .send({ name: 'Efectivo', kind: 'cash' })
        .expect(201)
    ).body;

    const expenseRes = await post(
      '/api/v1/transactions/expenses',
      authG,
      {
        bookedAt: '2026-08-05',
        description: 'Wifi agosto',
        paidFromAccountId: g.accounts.tdc,
        totalCents: '70000',
        lines: [{ categoryId: g.accounts.comida, amountCents: '70000' }],
      },
      randomUUID(),
    ).expect(201);
    responses['transactions.expense-create.json'] = expenseRes.body;
    const expenseId = expenseRes.body.id as string;

    responses['transactions.detail.json'] = (
      await request(app.getHttpServer()).get(`/api/v1/transactions/${expenseId}`).set('Authorization', authG).expect(200)
    ).body;

    responses['transactions.list.json'] = (
      await request(app.getHttpServer()).get('/api/v1/transactions?limit=100').set('Authorization', authG).expect(200)
    ).body;

    responses['accounts.ledger.json'] = (
      await request(app.getHttpServer())
        .get(`/api/v1/accounts/${g.accounts.tdc}/ledger`)
        .set('Authorization', authG)
        .expect(200)
    ).body;

    await post('/api/v1/periods/' + g.periods.p1 + '/allocations', authG, {
      categoryId: g.accounts.comida,
      amountCents: '200000',
    }).expect(201);

    responses['categories.list-with-period.json'] = (
      await request(app.getHttpServer())
        .get(`/api/v1/categories?periodId=${g.periods.p1}`)
        .set('Authorization', authG)
        .expect(200)
    ).body;

    responses['allocations.list.json'] = (
      await request(app.getHttpServer())
        .get(`/api/v1/periods/${g.periods.p1}/allocations`)
        .set('Authorization', authG)
        .expect(200)
    ).body;

    responses['allocations.set.json'] = (
      await request(app.getHttpServer())
        .put(`/api/v1/periods/${g.periods.p1}/allocations/${g.accounts.comida}`)
        .set('Authorization', authG)
        .send({ targetAssignedCents: '300000' })
        .expect(200)
    ).body;

    responses['periods.list.json'] = (
      await request(app.getHttpServer()).get('/api/v1/periods?pageSize=100').set('Authorization', authG).expect(200)
    ).body;

    responses['income-sources.list.json'] = (
      await request(app.getHttpServer()).get('/api/v1/income-sources').set('Authorization', authG).expect(200)
    ).body;

    const templateRes = await post('/api/v1/recurring-templates', authG, {
      name: 'Wifi Totalplay',
      categoryId: g.accounts.servicios,
      accountId: g.accounts.tdc,
      amountCents: '70000',
      dayOfMonth: 15,
    }).expect(201);
    const templateId = templateRes.body.id as string;

    responses['recurring.list.json'] = (
      await request(app.getHttpServer())
        .get('/api/v1/recurring-templates?pageSize=100')
        .set('Authorization', authG)
        .expect(200)
    ).body;

    responses['recurring.confirm.json'] = (
      await post(`/api/v1/recurring-templates/${templateId}/confirm`, authG, { bookedAt: '2026-08-06' }, randomUUID()).expect(
        201,
      )
    ).body;

    responses['errors.validation-failed.json'] = (
      await request(app.getHttpServer())
        .post('/api/v1/accounts')
        .set('Authorization', authG)
        .send({ name: 'Bogus', kind: 'cash', bogus: 'y' })
        .expect(400)
    ).body;

    responses['errors.not-found.json'] = (
      await request(app.getHttpServer())
        .get(`/api/v1/accounts/${randomUUID()}`)
        .set('Authorization', authG)
        .expect(404)
    ).body;

    responses['profile.me.json'] = (
      await request(app.getHttpServer()).get('/api/v1/me').set('Authorization', authG).expect(200)
    ).body;

    // ── Escenario de cierre: Servicios (accumulate) con sobrante,
    //    Comida (reset) con déficit — mismo patrón que T-M12.
    const cFixture = await seedFixtureCommitted();
    const c = cFixture.a;
    const authC = bearerFor(c.userId);
    await commitSetup(async (client) => {
      await insertBudgetEntry(client, { userId: c.userId, periodId: c.periods.p1, categoryId: c.accounts.servicios, amountCents: 200_000 });
      await insertBalancedTransaction(client, {
        userId: c.userId,
        bookedAt: '2026-08-05',
        entries: [
          { accountId: c.accounts.tdc, amountCents: -50_000 },
          { accountId: c.accounts.servicios, amountCents: 50_000 },
        ],
      });
      await insertBudgetEntry(client, { userId: c.userId, periodId: c.periods.p1, categoryId: c.accounts.comida, amountCents: 20_000 });
      await insertBalancedTransaction(client, {
        userId: c.userId,
        bookedAt: '2026-08-06',
        entries: [
          { accountId: c.accounts.tdc, amountCents: -50_000 },
          { accountId: c.accounts.comida, amountCents: 50_000 },
        ],
      });
    });

    responses['periods.close-preview.json'] = (
      await request(app.getHttpServer())
        .get(`/api/v1/periods/${c.periods.p1}/close-preview`)
        .set('Authorization', authC)
        .expect(200)
    ).body;

    responses['periods.close.json'] = (
      await request(app.getHttpServer()).post(`/api/v1/periods/${c.periods.p1}/close`).set('Authorization', authC).expect(200)
    ).body;

    responses['errors.period-closed.json'] = (
      await post(`/api/v1/periods/${c.periods.p1}/allocations`, authC, { categoryId: c.accounts.hogar, amountCents: '1000' }).expect(
        409,
      )
    ).body;

    // ── Escenario canónico de §3.9 (T-O04), reusado tal cual.
    const canonFixture = await seedFixtureCommitted();
    const canon = canonFixture.a;
    const authCanon = bearerFor(canon.userId);
    await commitSetup(async (client) => {
      await insertBalancedTransaction(client, {
        userId: canon.userId,
        bookedAt: '2026-08-05',
        entries: [
          { accountId: canon.accounts.nu, amountCents: 1_000_000 },
          { accountId: canon.accounts.sueldo, amountCents: -1_000_000 },
        ],
      });
      await insertBudgetEntry(client, { userId: canon.userId, periodId: canon.periods.p1, categoryId: canon.accounts.comida, amountCents: 200_000 });
      await insertBalancedTransaction(client, {
        userId: canon.userId,
        bookedAt: '2026-08-05',
        entries: [
          { accountId: canon.accounts.nu, amountCents: -50_000 },
          { accountId: canon.accounts.comida, amountCents: 50_000 },
        ],
      });
      await insertBalancedTransaction(client, {
        userId: canon.userId,
        bookedAt: '2026-08-06',
        entries: [
          { accountId: canon.accounts.nu, amountCents: -30_000 },
          { accountId: canon.accounts.salud, amountCents: 30_000 },
        ],
      });
    });

    responses['insights.account-balances.json'] = (
      await request(app.getHttpServer()).get('/api/v1/insights/account-balances').set('Authorization', authCanon).expect(200)
    ).body;
    responses['insights.category-balances.json'] = (
      await request(app.getHttpServer())
        .get(`/api/v1/insights/category-balances?periodId=${canon.periods.p1}`)
        .set('Authorization', authCanon)
        .expect(200)
    ).body;
    responses['insights.unassigned-funds.json'] = (
      await request(app.getHttpServer()).get('/api/v1/insights/unassigned-funds').set('Authorization', authCanon).expect(200)
    ).body;

    // ── Escenario de dashboard: mismo patrón + un gasto en hueco, para
    //    que los cuatro bloques (incl. unbudgeted) salgan consistentes
    //    entre sí en UNA sola llamada real.
    const dashFixture = await seedFixtureCommitted();
    const dash = dashFixture.a;
    const authDash = bearerFor(dash.userId);
    await commitSetup(async (client) => {
      await insertBalancedTransaction(client, {
        userId: dash.userId,
        bookedAt: '2026-08-05',
        entries: [
          { accountId: dash.accounts.nu, amountCents: 1_000_000 },
          { accountId: dash.accounts.sueldo, amountCents: -1_000_000 },
        ],
      });
      await insertBudgetEntry(client, { userId: dash.userId, periodId: dash.periods.p1, categoryId: dash.accounts.comida, amountCents: 200_000 });
      await insertBalancedTransaction(client, {
        userId: dash.userId,
        bookedAt: '2026-08-05',
        entries: [
          { accountId: dash.accounts.nu, amountCents: -50_000 },
          { accountId: dash.accounts.comida, amountCents: 50_000 },
        ],
      });
      await insertBalancedTransaction(client, {
        userId: dash.userId,
        bookedAt: '2026-06-01',
        description: 'Gasto en hueco',
        entries: [
          { accountId: dash.accounts.tdc, amountCents: -1_500 },
          { accountId: dash.accounts.transporte, amountCents: 1_500 },
        ],
      });
    });

    responses['insights.unbudgeted-transactions.json'] = (
      await request(app.getHttpServer()).get('/api/v1/insights/unbudgeted-transactions').set('Authorization', authDash).expect(200)
    ).body;
    responses['insights.dashboard.json'] = (
      await request(app.getHttpServer())
        .get(`/api/v1/insights/dashboard?periodId=${dash.periods.p1}`)
        .set('Authorization', authDash)
        .expect(200)
    ).body;

    // ── Escenario de captura tardía — periodos relativos a "hoy",
    //    mismo helper que usó Grupo S en la sesión 1.
    const lateFixture = await seedFixtureCommitted();
    const late = lateFixture.a;
    const authLate = bearerFor(late.userId);
    const latePeriods = await seedLateCapturePeriods(late.userId);

    responses['transactions.expense-create-late.json'] = (
      await post(
        '/api/v1/transactions/expenses',
        authLate,
        {
          bookedAt: latePeriods.bookedAtInClosedPeriod,
          description: 'Wifi agosto',
          paidFromAccountId: late.accounts.tdc,
          totalCents: '70000',
          lines: [{ categoryId: late.accounts.comida, amountCents: '70000' }],
        },
        randomUUID(),
      ).expect(201)
    ).body;
  }, 120_000);

  afterAll(async () => {
    await handle.close();
    await pool.end();
  });

  const plainFixtures = [
    'accounts.list.json',
    'accounts.create.json',
    'accounts.ledger.json',
    'categories.list-with-period.json',
    'income-sources.list.json',
    'transactions.expense-create.json',
    'transactions.detail.json',
    'transactions.list.json',
    'periods.list.json',
    'periods.close-preview.json',
    'periods.close.json',
    'allocations.list.json',
    'allocations.set.json',
    'insights.account-balances.json',
    'insights.category-balances.json',
    'insights.unassigned-funds.json',
    'insights.unbudgeted-transactions.json',
    'insights.dashboard.json',
    'errors.validation-failed.json',
    'errors.period-closed.json',
    'errors.not-found.json',
    'profile.me.json',
  ];

  it.each(plainFixtures)('T-R09 (%s): la respuesta real coincide con el fixture versionado, tras normalizar uuid/timestamp', (name) => {
    expectMatchesFixture(responses[name], name);
  });

  it('T-R09 (recurring.list.json): coincide con el fixture — nextDueOn se normaliza (depende de "hoy" al crear)', () => {
    expectMatchesFixture(responses['recurring.list.json'], 'recurring.list.json', ['nextDueOn']);
  });

  it('T-R09 (recurring.confirm.json): coincide con el fixture — isDue se verifica contra "hoy" real, no contra el valor congelado', () => {
    // `isDue` es un booleano derivado de `nextDueOn <= today` (real,
    // por profile.timezone) — a diferencia de un campo de fecha, no hay
    // un placeholder de tipo string que lo normalice. `nextDueOn` de
    // este fixture es fijo ("2026-08-15"); en vez de comparar el
    // booleano contra un valor congelado en el fixture (que se
    // desincroniza el día que el calendario real alcanza esa fecha, tal
    // como pasó), se recalcula con la misma función que usa el Service
    // y se compara aparte. El resto del objeto sí compara literal
    // contra el fixture.
    const actual = responses['recurring.confirm.json'] as { template: { nextDueOn: string; isDue: boolean } };
    const today = todayInTimezone('America/Mexico_City');
    expect(actual.template.isDue).toBe(actual.template.nextDueOn <= today);

    const { isDue: _isDue, ...templateWithoutIsDue } = actual.template;
    const expected = loadFixture('recurring.confirm.json') as { template: Record<string, unknown> };
    const { isDue: _expectedIsDue, ...expectedTemplateWithoutIsDue } = expected.template;
    expect(normalize({ ...actual, template: templateWithoutIsDue }, new Set())).toEqual({
      ...expected,
      template: expectedTemplateWithoutIsDue,
    });
  });

  it('T-R09 (transactions.expense-create-late.json): coincide con el fixture — bookedAt se normaliza (periodo relativo a "hoy")', () => {
    expectMatchesFixture(responses['transactions.expense-create-late.json'], 'transactions.expense-create-late.json', [
      'bookedAt',
    ]);
  });

  it('T-R01: todo campo *Cents en las respuestas capturadas es string, nunca number', () => {
    const violations: string[] = [];

    function walk(value: unknown, path: string): void {
      if (Array.isArray(value)) {
        value.forEach((v, i) => walk(v, `${path}[${i}]`));
      } else if (value !== null && typeof value === 'object') {
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          const childPath = `${path}.${k}`;
          if (k.endsWith('Cents') && typeof v !== 'string') {
            violations.push(`${childPath} = ${JSON.stringify(v)} (${typeof v})`);
          }
          walk(v, childPath);
        }
      }
    }

    const names = Object.keys(responses);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      walk(responses[name], name);
    }
    expect(violations).toEqual([]);
  });

  it('T-R02: GET /accounts sin el prefijo /api/v1 → 404 (todas las rutas viven bajo el prefijo)', async () => {
    await request(app.getHttpServer()).get('/accounts').expect(404);
  });

  it('T-R03: un POST con un campo extra no declarado → 400 VALIDATION_FAILED con details que nombra el campo', async () => {
    const fixture = await seedFixtureCommitted();
    const auth = bearerFor(fixture.a.userId);

    const res = await request(app.getHttpServer())
      .post('/api/v1/accounts')
      .set('Authorization', auth)
      .send({ name: 'Con campo extra', kind: 'cash', campoQueNoExiste: true })
      .expect(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(res.body.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'campoQueNoExiste' })]),
    );
  });

  it('T-R04: un monto de 9007199254740993 centavos (> 2^53) hace round-trip exacto, cero pérdida de precisión', async () => {
    const fixture = await seedFixtureCommitted();
    const f = fixture.a;
    const auth = bearerFor(f.userId);
    const receivableId = randomUUID();
    await commitSetup(async (client) => {
      await insertAccount(client, { id: receivableId, userId: f.userId, name: 'Fer R04', type: 'receivable' });
    });

    const HUGE = '9007199254740993';
    const res = await request(app.getHttpServer())
      .post('/api/v1/transactions/loans')
      .set('Authorization', auth)
      .set('Idempotency-Key', randomUUID())
      .send({
        bookedAt: '2026-08-05',
        description: 'Préstamo enorme R04',
        fromAccountId: f.accounts.nu,
        receivableAccountId: receivableId,
        amountCents: HUGE,
      })
      .expect(201);
    expect(res.body.totalCents).toBe(HUGE);

    const detail = await request(app.getHttpServer())
      .get(`/api/v1/transactions/${res.body.id}`)
      .set('Authorization', auth)
      .expect(200);
    const receivableMovement = (detail.body.movements as Array<{ accountId: string; amountCents: string }>).find(
      (m) => m.accountId === receivableId,
    );
    expect(receivableMovement?.amountCents).toBe(HUGE);
  });

  it('T-R11: la respuesta de creación de POST /transactions/* no contiene movements ni ningún arreglo de montos por cuenta — sí budgetImpact', () => {
    const created = responses['transactions.expense-create.json'] as Record<string, unknown>;
    expect(created).toHaveProperty('budgetImpact');
    expect(created).not.toHaveProperty('movements');
    for (const value of Object.values(created)) {
      expect(Array.isArray(value)).toBe(false);
    }
  });

  it('T-R12: budget_entries solo se escribe en BudgetModule y PrismaTransactionRepository — cero en cualquier otro lugar', () => {
    const src = join(__dirname, '../../../../src');
    const allowedDir = join(src, 'budget');
    const allowedFile = join(src, 'shared/ledger/repositories/prisma-transaction.repository.ts');

    const allFiles = walkTsFiles(src);
    expect(allFiles.length).toBeGreaterThan(0);

    const candidates = allFiles.filter((f) => !f.startsWith(allowedDir + '/') && f !== allowedFile);
    // Escrituras reales, no cualquier mención: un SELECT de lectura
    // (p. ej. `hasLiveAllocationsInOpenPeriods`), un nombre de constraint
    // (`budget_entries_rollover_uniq`) o un comentario explicando la regla
    // no son una violación — solo lo es INSERT/UPDATE/DELETE crudo sobre
    // la tabla, o los métodos tipados de Prisma que escriben.
    const violations = candidates.filter((f) =>
      /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+budget_entries\b|budgetEntry\.(?:create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/i.test(
        readFileSync(f, 'utf-8'),
      ),
    );
    expect(violations).toEqual([]);
  });
});
