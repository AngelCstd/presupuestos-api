import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { createTestApp, type TestAppHandle } from '../_helpers/app';
import { bearerFor } from '../_helpers/auth';
import { pool, seedFixtureCommitted, type Fixture } from '../_helpers/seed';
import { insertAccount, insertPeriod } from '../../../setup/fixture';
import { insertRecurringTemplate } from '../../../setup/recurring';
import { seedLateCapturePeriods, addDays, type LateCapturePeriods } from '../_helpers/periods';
import { countTransactionsSql, countEntriesSql, countBudgetEntriesSql } from '../_helpers/reject';
import { expectCents } from '../_helpers/cents';

// Grupo S — captura tardía (TASK-api.md §11, T-S01–S17). El más delicado
// de la API: cada test afirma sobre el ESTADO DE LA BASE, nunca solo sobre
// el status HTTP. TransactionsModule no existe todavía — rojo por diseño.
// CategoriesModule (A06, loop 1) sí existe. RecurringModule (A09) no
// existe todavía tampoco — T-S12 lo importa igual, mismo patrón "rojo por
// diseño" que TransactionsModule; hasta que A09 se implemente (sesión 3),
// este archivo entero seguirá sin compilar por esa razón además de por
// TransactionsModule.
import { TransactionsModule } from '../../../../src/transactions/transactions.module';
import { CategoriesModule } from '../../../../src/categories/categories.module';
import { RecurringModule } from '../../../../src/recurring/recurring.module';
import { PrismaQueryRepository } from '../../../../src/shared/queries/repositories/prisma-query.repository';

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

async function newReceivable(userId: string, name: string): Promise<string> {
  const id = randomUUID();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await insertAccount(client, { id, userId, name, type: 'receivable' });
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  return id;
}

interface BudgetEntryRow {
  amount_cents: string;
  source: string;
  note: string | null;
}

async function budgetEntriesFor(userId: string, periodId: string, categoryId: string): Promise<BudgetEntryRow[]> {
  const res = await pool.query(
    `SELECT amount_cents, source, note FROM budget_entries
     WHERE user_id = $1 AND period_id = $2 AND category_id = $3 AND deleted_at IS NULL`,
    [userId, periodId, categoryId],
  );
  return res.rows as BudgetEntryRow[];
}

describe('TransactionsModule — late-capture.integration.spec.ts (Grupo S)', () => {
  let app: INestApplication;
  let handle: TestAppHandle;
  let fixture: Fixture;
  let authA: string;
  let periods: LateCapturePeriods;
  let queryRepository: PrismaQueryRepository;
  const prisma = new PrismaClient();

  beforeAll(async () => {
    fixture = await seedFixtureCommitted();
    authA = bearerFor(fixture.a.userId);
    periods = await seedLateCapturePeriods(fixture.a.userId);

    handle = await createTestApp([TransactionsModule, CategoriesModule, RecurringModule]);
    app = handle.app;
    queryRepository = new PrismaQueryRepository(prisma);
  });

  afterAll(async () => {
    await handle.close();
    await prisma.$disconnect();
    await pool.end();
  });

  function post(path: string, body: Record<string, unknown>, idemKey = randomUUID(), auth = authA) {
    return request(app.getHttpServer()).post(path).set('Authorization', auth).set('Idempotency-Key', idemKey).send(body);
  }

  function postExpense(categoryId: string, bookedAt: string, totalCents: string, idemKey = randomUUID()) {
    return post(
      '/api/v1/transactions/expenses',
      {
        bookedAt,
        description: 'gasto tardío',
        paidFromAccountId: fixture.a.accounts.tdc,
        totalCents,
        lines: [{ categoryId, amountCents: totalCents }],
      },
      idemKey,
    );
  }

  it('T-S01: gasto tardío de "50000" → 201; budget_entry manual −50000 en P2 contra la categoría, con note referenciando la tx; budgetImpact compensated', async () => {
    const categoryId = await newCategory(fixture.a.userId, 'Comida S01');

    const res = await postExpense(categoryId, periods.bookedAtInClosedPeriod, '50000').expect(201);
    expect(res.body.budgetImpact).toMatchObject({
      status: 'compensated',
      closedPeriodId: periods.closedPeriodId,
      compensatedInPeriodId: periods.openPeriodId,
    });
    expect(res.body.budgetImpact.compensations).toEqual([
      expect.objectContaining({ categoryId, amountCents: '-50000' }),
    ]);

    const rows = await budgetEntriesFor(fixture.a.userId, periods.openPeriodId, categoryId);
    expect(rows).toHaveLength(1);
    expectCents(rows[0].amount_cents, -50000);
    expect(rows[0].source).toBe('manual');
    expect(rows[0].note).toContain(res.body.id);
    expect(rows[0].note).toContain(periods.bookedAtInClosedPeriod);
  });

  it('T-S02: el compensatorio aparece entre los budget_entries vigentes de P2 (lo que listaría GET /periods/{id}/allocations)', async () => {
    const categoryId = await newCategory(fixture.a.userId, 'Comida S02');
    const res = await postExpense(categoryId, periods.bookedAtInClosedPeriod, '15000').expect(201);

    // Positivo primero: P2 sí tiene budget_entries vigentes en general.
    const allInPeriod = await pool.query(
      'SELECT count(*)::int AS n FROM budget_entries WHERE period_id = $1 AND deleted_at IS NULL',
      [periods.openPeriodId],
    );
    expect(allInPeriod.rows[0].n).toBeGreaterThan(0);

    const rows = await budgetEntriesFor(fixture.a.userId, periods.openPeriodId, categoryId);
    expect(rows).toHaveLength(1);
    expect(rows[0].note).toContain(res.body.id);
  });

  it('T-S03: GET /categories?periodId=P2 — assignedCents reducido en 50000; spentCents sin cambio (el gasto es de P1)', async () => {
    const categoryId = await newCategory(fixture.a.userId, 'Comida S03');

    const before = await request(app.getHttpServer())
      .get(`/api/v1/categories?periodId=${periods.openPeriodId}`)
      .set('Authorization', authA)
      .expect(200);
    const beforeRow = (before.body.data as Array<{ id: string; period: { assignedCents: string; spentCents: string } }>).find(
      (c) => c.id === categoryId,
    )!;
    expect(beforeRow.period.assignedCents).toBe('0');

    await postExpense(categoryId, periods.bookedAtInClosedPeriod, '50000').expect(201);

    const after = await request(app.getHttpServer())
      .get(`/api/v1/categories?periodId=${periods.openPeriodId}`)
      .set('Authorization', authA)
      .expect(200);
    const afterRow = (after.body.data as Array<{ id: string; period: { assignedCents: string; spentCents: string } }>).find(
      (c) => c.id === categoryId,
    )!;
    expect(afterRow.period.assignedCents).toBe('-50000');
    expect(afterRow.period.spentCents).toBe('0');
  });

  it('T-S04: F2 del periodo cerrado (P1) — el gasto SÍ aparece en spentCents; el periodo cerrado conserva su historia', async () => {
    const categoryId = await newCategory(fixture.a.userId, 'Comida S04');

    const before = await queryRepository.categoryBalances(fixture.a.userId, periods.closedPeriodId);
    const beforeSpent = before.find((c) => c.categoryId === categoryId)?.spentCents ?? 0n;

    await postExpense(categoryId, periods.bookedAtInClosedPeriod, '20000').expect(201);

    const after = await queryRepository.categoryBalances(fixture.a.userId, periods.closedPeriodId);
    const afterSpent = after.find((c) => c.categoryId === categoryId)?.spentCents ?? 0n;
    expect(afterSpent - beforeSpent).toBe(20000n);
  });

  it('T-S05 ❌: mismo gasto pero sin ningún periodo abierto que cubra hoy → 201, cero budget_entries nuevos, budgetImpact.status="uncompensated"', async () => {
    const noOpenFixture = await seedFixtureCommitted();
    const authNoOpen = bearerFor(noOpenFixture.a.userId);
    const client = await pool.connect();
    let closedOnlyPeriodId: string;
    try {
      await client.query('BEGIN');
      await client.query('UPDATE budget_periods SET deleted_at = now() WHERE user_id = $1 AND deleted_at IS NULL', [
        noOpenFixture.a.userId,
      ]);
      closedOnlyPeriodId = randomUUID();
      await insertPeriod(client, {
        id: closedOnlyPeriodId,
        userId: noOpenFixture.a.userId,
        startsOn: '2020-01-01',
        endsOn: '2020-01-31',
        closedAt: new Date().toISOString(),
      });
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    const categoryId = await newCategory(noOpenFixture.a.userId, 'Comida S05');
    const before = await pool.query(countBudgetEntriesSql(), [noOpenFixture.a.userId]);

    const res = await post(
      '/api/v1/transactions/expenses',
      {
        bookedAt: '2020-01-15',
        description: 'gasto sin periodo abierto',
        paidFromAccountId: noOpenFixture.a.accounts.tdc,
        totalCents: '5000',
        lines: [{ categoryId, amountCents: '5000' }],
      },
      randomUUID(),
      authNoOpen,
    ).expect(201);
    expect(res.body.budgetImpact.status).toBe('uncompensated');
    expect(res.body.budgetImpact.compensations).toEqual([]);

    const after = await pool.query(countBudgetEntriesSql(), [noOpenFixture.a.userId]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it('T-S06: gasto tardío repartido entre dos categorías → dos compensatorios, uno por categoría', async () => {
    const comidaId = await newCategory(fixture.a.userId, 'Comida S06');
    const saludId = await newCategory(fixture.a.userId, 'Salud S06');

    await post('/api/v1/transactions/expenses', {
      bookedAt: periods.bookedAtInClosedPeriod,
      description: 'gasto repartido',
      paidFromAccountId: fixture.a.accounts.tdc,
      totalCents: '50000',
      lines: [
        { categoryId: comidaId, amountCents: '30000' },
        { categoryId: saludId, amountCents: '20000' },
      ],
    }).expect(201);

    const comidaRows = await budgetEntriesFor(fixture.a.userId, periods.openPeriodId, comidaId);
    const saludRows = await budgetEntriesFor(fixture.a.userId, periods.openPeriodId, saludId);
    expect(comidaRows).toHaveLength(1);
    expectCents(comidaRows[0].amount_cents, -30000);
    expect(saludRows).toHaveLength(1);
    expectCents(saludRows[0].amount_cents, -20000);
  });

  it('T-S07: la misma categoría dos veces en lines → un solo compensatorio agregado', async () => {
    const categoryId = await newCategory(fixture.a.userId, 'Comida S07');

    await post('/api/v1/transactions/expenses', {
      bookedAt: periods.bookedAtInClosedPeriod,
      description: 'misma categoría dos veces',
      paidFromAccountId: fixture.a.accounts.tdc,
      totalCents: '70000',
      lines: [
        { categoryId, amountCents: '30000' },
        { categoryId, amountCents: '40000' },
      ],
    }).expect(201);

    const rows = await budgetEntriesFor(fixture.a.userId, periods.openPeriodId, categoryId);
    expect(rows).toHaveLength(1);
    expectCents(rows[0].amount_cents, -70000);
  });

  it('T-S08: repetir con la misma Idempotency-Key → 200, cero budget_entries nuevos, budgetImpact idéntico', async () => {
    const categoryId = await newCategory(fixture.a.userId, 'Comida S08');
    const idemKey = randomUUID();

    const first = await postExpense(categoryId, periods.bookedAtInClosedPeriod, '12000', idemKey).expect(201);

    const before = await pool.query(countBudgetEntriesSql(), [fixture.a.userId]);
    const second = await postExpense(categoryId, periods.bookedAtInClosedPeriod, '12000', idemKey).expect(200);
    const after = await pool.query(countBudgetEntriesSql(), [fixture.a.userId]);

    expect(after.rows[0].n).toBe(before.rows[0].n);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.budgetImpact).toEqual(first.body.budgetImpact);
  });

  it('T-S09: reversa sin bookedAt → segundo budget_entry de +50000; la suma de los dos compensatorios es 0', async () => {
    const categoryId = await newCategory(fixture.a.userId, 'Comida S09');
    const original = await postExpense(categoryId, periods.bookedAtInClosedPeriod, '50000').expect(201);

    await post(`/api/v1/transactions/${original.body.id}/reversal`, {}).expect(201);

    const rows = await budgetEntriesFor(fixture.a.userId, periods.openPeriodId, categoryId);
    expect(rows).toHaveLength(2);
    const sum = rows.reduce((acc, r) => acc + BigInt(r.amount_cents), 0n);
    expect(sum).toBe(0n);
  });

  it('T-S10 ❌: reversa con bookedAt sobreescrito (hoy, dentro de P2) de un original que SÍ compensó → 422 REVERSAL_DATE_LOCKED, cero filas', async () => {
    const categoryId = await newCategory(fixture.a.userId, 'Comida S10');
    const original = await postExpense(categoryId, periods.bookedAtInClosedPeriod, '8000').expect(201);

    const beforeTx = await pool.query(countTransactionsSql(), [fixture.a.userId]);
    const beforeEntries = await pool.query(countEntriesSql(), [fixture.a.userId]);
    const beforeBudget = await pool.query(countBudgetEntriesSql(), [fixture.a.userId]);

    const res = await post(`/api/v1/transactions/${original.body.id}/reversal`, { bookedAt: periods.today }).expect(
      422,
    );
    expect(res.body.code).toBe('REVERSAL_DATE_LOCKED');

    const afterTx = await pool.query(countTransactionsSql(), [fixture.a.userId]);
    const afterEntries = await pool.query(countEntriesSql(), [fixture.a.userId]);
    const afterBudget = await pool.query(countBudgetEntriesSql(), [fixture.a.userId]);
    expect(afterTx.rows[0].n).toBe(beforeTx.rows[0].n);
    expect(afterEntries.rows[0].n).toBe(beforeEntries.rows[0].n);
    expect(afterBudget.rows[0].n).toBe(beforeBudget.rows[0].n);
  });

  it('T-S10b: reversa con bookedAt sobreescrito de un original SIN compensatorio (bookedAt en periodo abierto) → 201, el campo sigue siendo sobreescribible', async () => {
    const categoryId = await newCategory(fixture.a.userId, 'Comida S10b');
    const original = await postExpense(categoryId, periods.today, '9000').expect(201);
    expect(original.body.budgetImpact.status).toBe('in_open_period');

    const overriddenDate = addDays(periods.today, 1);
    const res = await post(`/api/v1/transactions/${original.body.id}/reversal`, { bookedAt: overriddenDate }).expect(
      201,
    );
    expect(res.body.bookedAt).toBe(overriddenDate);
  });

  it('T-S11: loan-write-off con bookedAt tardío → compensatorio negativo en P2 contra la categoría indicada', async () => {
    const categoryId = await newCategory(fixture.a.userId, 'Comida S11');
    const receivableId = await newReceivable(fixture.a.userId, 'Fer S11');
    await post('/api/v1/transactions/loans', {
      bookedAt: periods.today,
      description: 'préstamo S11',
      fromAccountId: fixture.a.accounts.nu,
      receivableAccountId: receivableId,
      amountCents: '30000',
    }).expect(201);

    await post('/api/v1/transactions/loan-write-offs', {
      bookedAt: periods.bookedAtInClosedPeriod,
      description: 'incobrable S11',
      receivableAccountId: receivableId,
      categoryId,
      amountCents: '30000',
    }).expect(201);

    const rows = await budgetEntriesFor(fixture.a.userId, periods.openPeriodId, categoryId);
    expect(rows).toHaveLength(1);
    expectCents(rows[0].amount_cents, -30000);
  });

  it('T-S12: recurring-templates/{id}/confirm con bookedAt tardío → compensatorio negativo en P2; budgetImpact dentro de transaction', async () => {
    const categoryId = await newCategory(fixture.a.userId, 'Comida S12');
    const templateId = randomUUID();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await insertRecurringTemplate(client, {
        id: templateId,
        userId: fixture.a.userId,
        name: 'Wifi S12',
        accountId: fixture.a.accounts.tdc,
        categoryId,
        amountCents: 40000,
        dayOfMonth: 15,
        nextDueOn: periods.today,
      });
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    const res = await post(`/api/v1/recurring-templates/${templateId}/confirm`, {
      bookedAt: periods.bookedAtInClosedPeriod,
    }).expect(201);

    expect(res.body.transaction.budgetImpact).toMatchObject({
      status: 'compensated',
      closedPeriodId: periods.closedPeriodId,
      compensatedInPeriodId: periods.openPeriodId,
    });

    const rows = await budgetEntriesFor(fixture.a.userId, periods.openPeriodId, categoryId);
    expect(rows).toHaveLength(1);
    expectCents(rows[0].amount_cents, -40000);
  });

  it('T-S13: transferencia, ingreso, préstamo y cobro con bookedAt tardío → los cuatro 201, cero compensatorios (no tocan categorías)', async () => {
    const before = await pool.query(countBudgetEntriesSql(), [fixture.a.userId]);

    const transferRes = await post('/api/v1/transactions/transfers', {
      bookedAt: periods.bookedAtInClosedPeriod,
      description: 'transfer tardía',
      fromAccountId: fixture.a.accounts.nu,
      toAccountId: fixture.a.accounts.tdc,
      amountCents: '1000',
    }).expect(201);
    expect(transferRes.body.budgetImpact.compensations).toEqual([]);

    const incomeRes = await post('/api/v1/transactions/incomes', {
      bookedAt: periods.bookedAtInClosedPeriod,
      description: 'ingreso tardío',
      toAccountId: fixture.a.accounts.nu,
      sourceId: fixture.a.accounts.sueldo,
      amountCents: '1000',
    }).expect(201);
    expect(incomeRes.body.budgetImpact.compensations).toEqual([]);

    const receivableId = await newReceivable(fixture.a.userId, 'Fer S13');
    const loanRes = await post('/api/v1/transactions/loans', {
      bookedAt: periods.bookedAtInClosedPeriod,
      description: 'préstamo tardío',
      fromAccountId: fixture.a.accounts.nu,
      receivableAccountId: receivableId,
      amountCents: '1000',
    }).expect(201);
    expect(loanRes.body.budgetImpact.compensations).toEqual([]);

    const repaymentRes = await post('/api/v1/transactions/loan-repayments', {
      bookedAt: periods.bookedAtInClosedPeriod,
      description: 'cobro tardío',
      receivableAccountId: receivableId,
      toAccountId: fixture.a.accounts.nu,
      amountCents: '500',
    }).expect(201);
    expect(repaymentRes.body.budgetImpact.compensations).toEqual([]);

    const after = await pool.query(countBudgetEntriesSql(), [fixture.a.userId]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  // T-S14 retirado — ver nota en TASK-api.md §2.3. `findOpenPeriodCoveringDate`
  // filtra `closed_at IS NULL`, así que cerrar el periodo objetivo antes de
  // la petición da `uncompensated` (T-S05), no el choque contra R11; y la
  // única ventana real (entre esa lectura y el INSERT, dentro de la misma
  // petición) no es reproducible desde fuera de forma determinista sin
  // agregar un lock que ningún documento pide.

  it('T-S15: gasto en un hueco entre periodos → budgetImpact.status="no_period"; cero compensatorios; aparece en unbudgeted-transactions', async () => {
    const categoryId = await newCategory(fixture.a.userId, 'Comida S15');
    const res = await postExpense(categoryId, periods.bookedAtInGap, '4000').expect(201);
    expect(res.body.budgetImpact.status).toBe('no_period');
    expect(res.body.budgetImpact.compensations).toEqual([]);

    const orphans = await queryRepository.transactionsWithoutPeriod(fixture.a.userId);
    expect(orphans.some((o) => o.transactionId === res.body.id)).toBe(true);
  });

  it('T-S16: gasto con bookedAt dentro de P2 (abierto) → budgetImpact.status="in_open_period"; cero compensatorios', async () => {
    const categoryId = await newCategory(fixture.a.userId, 'Comida S16');
    const res = await postExpense(categoryId, periods.today, '3000').expect(201);
    expect(res.body.budgetImpact.status).toBe('in_open_period');
    expect(res.body.budgetImpact.compensations).toEqual([]);
  });

  it('T-S17: compensatorio contra categoría sin presupuesto en P2 → assignedCents negativo, hasBudget:true, status:"overspent", spentCents "0"', async () => {
    const categoryId = await newCategory(fixture.a.userId, 'Comida S17');
    await postExpense(categoryId, periods.bookedAtInClosedPeriod, '25000').expect(201);

    const res = await request(app.getHttpServer())
      .get(`/api/v1/categories?periodId=${periods.openPeriodId}`)
      .set('Authorization', authA)
      .expect(200);
    const row = (
      res.body.data as Array<{
        id: string;
        period: { assignedCents: string; spentCents: string; hasBudget: boolean; status: string };
      }>
    ).find((c) => c.id === categoryId)!;

    expect(row.period.assignedCents).toBe('-25000');
    expect(row.period.spentCents).toBe('0');
    expect(row.period.hasBudget).toBe(true);
    expect(row.period.status).toBe('overspent');
  });
});
