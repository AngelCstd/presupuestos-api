import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { createTestApp, type TestAppHandle } from '../_helpers/app';
import { bearerFor } from '../_helpers/auth';
import { pool, seedFixtureCommitted, type Fixture } from '../_helpers/seed';
import { insertRecurringTemplate } from '../../../setup/recurring';
import { expectRejection, countTransactionsSql } from '../_helpers/reject';
import { todayInMexicoCity } from '../_helpers/periods';

// Grupo N — recurrentes (TASK-api.md §11, T-N01–N14). RecurringModule no
// existe todavía — rojo por diseño, igual que TransactionsModule/
// BudgetModule en las sesiones 1 y 2.
import { RecurringModule } from '../../../../src/recurring/recurring.module';
import { nextDueOn } from '../../../../src/shared/recurrence/next-due-on';

interface EntryRow {
  account_id: string;
  amount_cents: string;
}

async function entriesOf(transactionId: string): Promise<EntryRow[]> {
  const res = await pool.query('SELECT account_id, amount_cents FROM entries WHERE transaction_id = $1', [
    transactionId,
  ]);
  return res.rows as EntryRow[];
}

function amountByAccount(rows: EntryRow[]): Map<string, bigint> {
  return new Map(rows.map((r) => [r.account_id, BigInt(r.amount_cents)]));
}

function isoDate(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00Z`);
}

describe('RecurringModule — recurring.integration.spec.ts (Grupo N)', () => {
  let app: INestApplication;
  let handle: TestAppHandle;
  let fixture: Fixture;
  let authA: string;

  beforeAll(async () => {
    fixture = await seedFixtureCommitted();
    authA = bearerFor(fixture.a.userId);

    handle = await createTestApp([RecurringModule]);
    app = handle.app;
  });

  afterAll(async () => {
    await handle.close();
    await pool.end();
  });

  function post(path: string, body: Record<string, unknown>, idemKey?: string) {
    const req = request(app.getHttpServer()).post(path).set('Authorization', authA);
    if (idemKey !== undefined) req.set('Idempotency-Key', idemKey);
    return req.send(body);
  }

  async function createTemplate(overrides: Partial<Record<string, unknown>> = {}): Promise<string> {
    const res = await post('/api/v1/recurring-templates', {
      name: 'Wifi N',
      categoryId: fixture.a.accounts.comida,
      accountId: fixture.a.accounts.tdc,
      amountCents: '70000',
      dayOfMonth: 15,
      ...overrides,
    }).expect(201);
    return res.body.id as string;
  }

  it('T-N01: POST {name,categoryId,amountCents:"70000",dayOfMonth:15} → 201; nextDueOn calculado con nextDueOn() de U08b', async () => {
    const res = await post('/api/v1/recurring-templates', {
      name: 'Wifi N01',
      categoryId: fixture.a.accounts.comida,
      amountCents: '70000',
      dayOfMonth: 15,
    }).expect(201);

    // Sin `lastConfirmedOn` (template nunca confirmado), la única fecha
    // de referencia disponible es "hoy" — se deriva con la misma función
    // pura U08b que el Service debe reusar, no se hardcodea un valor.
    const expected = nextDueOn(15, isoDate(todayInMexicoCity()));
    expect(res.body.nextDueOn).toBe(expected.toISOString().slice(0, 10));
  });

  it('T-N02 ❌: dayOfMonth:0 o 32 → 400 VALIDATION_FAILED', async () => {
    for (const dayOfMonth of [0, 32]) {
      const res = await post('/api/v1/recurring-templates', {
        name: `Inválido ${dayOfMonth}`,
        categoryId: fixture.a.accounts.comida,
        amountCents: '70000',
        dayOfMonth,
      }).expect(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    }
  });

  it('T-N03 ❌: amountCents:"-100" → 400 VALIDATION_FAILED', async () => {
    const res = await post('/api/v1/recurring-templates', {
      name: 'Monto negativo',
      categoryId: fixture.a.accounts.comida,
      amountCents: '-100',
      dayOfMonth: 15,
    }).expect(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
  });

  it('T-N04 ❌: categoryId de una cuenta asset → 422 INVALID_ACCOUNT_ROLE', async () => {
    const res = await post('/api/v1/recurring-templates', {
      name: 'categoryId inválido',
      categoryId: fixture.a.accounts.nu,
      amountCents: '70000',
      dayOfMonth: 15,
    }).expect(422);
    expect(res.body.code).toBe('INVALID_ACCOUNT_ROLE');
  });

  it('T-N05: confirm sin body, template con accountId=TDC → 201; TDC −70000, Comida +70000; bookedAt = hoy', async () => {
    const templateId = await createTemplate({ name: 'Wifi N05' });
    const res = await post(`/api/v1/recurring-templates/${templateId}/confirm`, {}, randomUUID()).expect(201);

    expect(res.body.transaction.bookedAt).toBe(todayInMexicoCity());
    const byAccount = amountByAccount(await entriesOf(res.body.transaction.id as string));
    expect(byAccount.get(fixture.a.accounts.tdc)).toBe(-70000n);
    expect(byAccount.get(fixture.a.accounts.comida)).toBe(70000n);
  });

  it('T-N06: confirm con amountCents:"72500" → la transacción usa 72500; el template conserva su estimado 70000', async () => {
    const templateId = await createTemplate({ name: 'Wifi N06' });
    const res = await post(
      `/api/v1/recurring-templates/${templateId}/confirm`,
      { amountCents: '72500' },
      randomUUID(),
    ).expect(201);

    expect(res.body.transaction.totalCents).toBe('72500');
    const byAccount = amountByAccount(await entriesOf(res.body.transaction.id as string));
    expect(byAccount.get(fixture.a.accounts.tdc)).toBe(-72500n);

    const templateRes = await request(app.getHttpServer())
      .get(`/api/v1/recurring-templates/${templateId}`)
      .set('Authorization', authA)
      .expect(200);
    expect(templateRes.body.amountCents).toBe('70000');
  });

  it('T-N07: confirm con paidFromAccountId=Nu → la transacción usa Nu; el template conserva TDC', async () => {
    const templateId = await createTemplate({ name: 'Wifi N07' });
    const res = await post(
      `/api/v1/recurring-templates/${templateId}/confirm`,
      { paidFromAccountId: fixture.a.accounts.nu },
      randomUUID(),
    ).expect(201);

    const byAccount = amountByAccount(await entriesOf(res.body.transaction.id as string));
    expect(byAccount.get(fixture.a.accounts.nu)).toBe(-70000n);
    expect(byAccount.has(fixture.a.accounts.tdc)).toBe(false);

    const templateRes = await request(app.getHttpServer())
      .get(`/api/v1/recurring-templates/${templateId}`)
      .set('Authorization', authA)
      .expect(200);
    expect(templateRes.body.accountId).toBe(fixture.a.accounts.tdc);
  });

  it('T-N08 ❌: confirm de un template sin accountId y sin paidFromAccountId en el body → 422 PAYMENT_ACCOUNT_REQUIRED, cero filas', async () => {
    const res = await post('/api/v1/recurring-templates', {
      name: 'Sin cuenta N08',
      categoryId: fixture.a.accounts.comida,
      amountCents: '10000',
      dayOfMonth: 10,
    }).expect(201);
    const templateId = res.body.id as string;

    await expectRejection({
      perform: () => post(`/api/v1/recurring-templates/${templateId}/confirm`, {}, randomUUID()).expect(422),
      code: 'PAYMENT_ACCOUNT_REQUIRED',
      countQueries: [{ sql: countTransactionsSql(), params: [fixture.a.userId] }],
    });
  });

  it('T-N09: dayOfMonth:31, lastConfirmedOn:2026-01-31, confirm con bookedAt:2026-03-01 → nextDueOn = 2026-03-31 (no salta a abril)', async () => {
    const templateId = randomUUID();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await insertRecurringTemplate(client, {
        id: templateId,
        userId: fixture.a.userId,
        name: 'Wifi N09',
        accountId: fixture.a.accounts.tdc,
        categoryId: fixture.a.accounts.comida,
        amountCents: 70000,
        dayOfMonth: 31,
        nextDueOn: '2026-02-28',
        lastConfirmedOn: '2026-01-31',
      });
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    await post(`/api/v1/recurring-templates/${templateId}/confirm`, { bookedAt: '2026-03-01' }, randomUUID()).expect(
      201,
    );

    const templateRes = await request(app.getHttpServer())
      .get(`/api/v1/recurring-templates/${templateId}`)
      .set('Authorization', authA)
      .expect(200);
    expect(templateRes.body.nextDueOn).toBe('2026-03-31');
    expect(templateRes.body.lastConfirmedOn).toBe('2026-03-01');
  });

  it('T-N10: confirm repetido con la misma Idempotency-Key → 200; una transacción; nextDueOn/lastConfirmedOn no avanzan dos veces', async () => {
    const templateId = await createTemplate({ name: 'Wifi N10', dayOfMonth: 20 });
    const key = randomUUID();

    await post(`/api/v1/recurring-templates/${templateId}/confirm`, { bookedAt: '2026-05-01' }, key).expect(201);
    const afterFirst = await request(app.getHttpServer())
      .get(`/api/v1/recurring-templates/${templateId}`)
      .set('Authorization', authA)
      .expect(200);

    const before = await pool.query(countTransactionsSql(), [fixture.a.userId]);
    await post(`/api/v1/recurring-templates/${templateId}/confirm`, { bookedAt: '2026-05-01' }, key).expect(200);
    const after = await pool.query(countTransactionsSql(), [fixture.a.userId]);
    expect(after.rows[0].n).toBe(before.rows[0].n);

    const afterSecond = await request(app.getHttpServer())
      .get(`/api/v1/recurring-templates/${templateId}`)
      .set('Authorization', authA)
      .expect(200);
    expect(afterSecond.body.nextDueOn).toBe(afterFirst.body.nextDueOn);
    expect(afterSecond.body.lastConfirmedOn).toBe(afterFirst.body.lastConfirmedOn);
  });

  it('T-N11: GET ?dueOnly=true → solo nextDueOn <= hoy, isActive=true, deletedAt nulo', async () => {
    const today = todayInMexicoCity();
    const client = await pool.connect();
    const dueId = randomUUID();
    const notYetDueId = randomUUID();
    const inactiveButDueId = randomUUID();
    const deletedButDueId = randomUUID();
    try {
      await client.query('BEGIN');
      await insertRecurringTemplate(client, {
        id: dueId,
        userId: fixture.a.userId,
        name: 'Due N11',
        accountId: fixture.a.accounts.tdc,
        categoryId: fixture.a.accounts.comida,
        amountCents: 1000,
        dayOfMonth: 1,
        nextDueOn: today,
      });
      await insertRecurringTemplate(client, {
        id: notYetDueId,
        userId: fixture.a.userId,
        name: 'No vencido N11',
        accountId: fixture.a.accounts.tdc,
        categoryId: fixture.a.accounts.comida,
        amountCents: 1000,
        dayOfMonth: 1,
        nextDueOn: '2099-01-01',
      });
      await insertRecurringTemplate(client, {
        id: inactiveButDueId,
        userId: fixture.a.userId,
        name: 'Inactivo N11',
        accountId: fixture.a.accounts.tdc,
        categoryId: fixture.a.accounts.comida,
        amountCents: 1000,
        dayOfMonth: 1,
        nextDueOn: today,
        isActive: false,
      });
      await insertRecurringTemplate(client, {
        id: deletedButDueId,
        userId: fixture.a.userId,
        name: 'Borrado N11',
        accountId: fixture.a.accounts.tdc,
        categoryId: fixture.a.accounts.comida,
        amountCents: 1000,
        dayOfMonth: 1,
        nextDueOn: today,
      });
      await client.query('UPDATE recurring_templates SET deleted_at = now() WHERE id = $1', [deletedButDueId]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    const res = await request(app.getHttpServer())
      .get('/api/v1/recurring-templates?dueOnly=true&pageSize=100')
      .set('Authorization', authA)
      .expect(200);
    const ids = (res.body.data as Array<{ id: string }>).map((t) => t.id);
    expect(ids).toContain(dueId);
    expect(ids).not.toContain(notYetDueId);
    expect(ids).not.toContain(inactiveButDueId);
    expect(ids).not.toContain(deletedButDueId);
  });

  it('T-N12: DELETE /recurring-templates/{id} → 204; deletedAt no nulo; desaparece del listado', async () => {
    const templateId = await createTemplate({ name: 'Para borrar N12' });

    await request(app.getHttpServer())
      .delete(`/api/v1/recurring-templates/${templateId}`)
      .set('Authorization', authA)
      .expect(204);

    const row = await pool.query('SELECT deleted_at FROM recurring_templates WHERE id = $1', [templateId]);
    expect(row.rows[0].deleted_at).not.toBeNull();

    const list = await request(app.getHttpServer())
      .get('/api/v1/recurring-templates?pageSize=200')
      .set('Authorization', authA)
      .expect(200);
    expect((list.body.data as Array<{ id: string }>).some((t) => t.id === templateId)).toBe(false);
  });

  it('T-N13 ❌: POST /recurring-templates/{id}/skip → 404, el endpoint no existe', async () => {
    const templateId = await createTemplate({ name: 'Sin skip N13' });
    await post(`/api/v1/recurring-templates/${templateId}/skip`, {}).expect(404);
  });

  it('T-N14: recurring.service.ts importa buildExpenseEntries y nextDueOn, no los reimplementa, no importa TransactionsModule (D4)', () => {
    const source = readFileSync(join(__dirname, '../../../../src/recurring/recurring.service.ts'), 'utf-8');

    expect(source).toMatch(/import\s+\{[^}]*buildExpenseEntries[^}]*\}\s+from/);
    expect(source).toMatch(/import\s+\{[^}]*nextDueOn[^}]*\}\s+from/);
    expect(source).not.toMatch(/from ['"].*transactions\/transactions\.module['"]/);
    expect(source).not.toMatch(/function\s+buildExpenseEntries/);
  });
});
