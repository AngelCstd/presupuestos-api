import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { createTestApp, type TestAppHandle } from '../_helpers/app';
import { bearerFor } from '../_helpers/auth';
import { pool, seedFixtureCommitted, type Fixture } from '../_helpers/seed';
import { expectRejection, countTransactionsSql } from '../_helpers/reject';

// Grupo A-http — idempotencia a nivel de header (TASK-api.md §11,
// T-A04/T-A05/T-A09/T-A20-A22). TransactionsModule no existe todavía —
// rojo por diseño. AccountsModule sí existe (loop 1, A05) — T-A09 lo
// necesita real para confirmar que el header se ignora ahí en silencio.
import { TransactionsModule } from '../../../../src/transactions/transactions.module';
import { AccountsModule } from '../../../../src/accounts/accounts.module';

describe('Idempotency-Key — idempotency-http.integration.spec.ts (Grupo A-http)', () => {
  let app: INestApplication;
  let handle: TestAppHandle;
  let fixture: Fixture;
  let authA: string;

  beforeAll(async () => {
    fixture = await seedFixtureCommitted();
    authA = bearerFor(fixture.a.userId);

    handle = await createTestApp([TransactionsModule, AccountsModule]);
    app = handle.app;
  });

  afterAll(async () => {
    await handle.close();
    await pool.end();
  });

  function expenseBody(): Record<string, unknown> {
    return {
      bookedAt: '2026-08-05',
      description: 'Wifi agosto',
      paidFromAccountId: fixture.a.accounts.tdc,
      totalCents: '70000',
      lines: [{ categoryId: fixture.a.accounts.comida, amountCents: '70000' }],
    };
  }

  function postExpense(idemKey?: string) {
    const req = request(app.getHttpServer()).post('/api/v1/transactions/expenses').set('Authorization', authA);
    if (idemKey !== undefined) {
      req.set('Idempotency-Key', idemKey);
    }
    return req.send(expenseBody());
  }

  it('T-A20: POST /transactions/expenses con llave K1 → 201; 1 fila en transactions', async () => {
    const before = await pool.query(countTransactionsSql(), [fixture.a.userId]);

    const res = await postExpense(randomUUID()).expect(201);
    expect(res.body.id).toBeDefined();

    const after = await pool.query(countTransactionsSql(), [fixture.a.userId]);
    expect(after.rows[0].n).toBe(before.rows[0].n + 1);
  });

  it('T-A21: repetir el mismo body con la misma K1 → 200, mismo id, cuerpo idéntico (incluido budgetImpact)', async () => {
    const key = randomUUID();
    const first = await postExpense(key).expect(201);

    const before = await pool.query(countTransactionsSql(), [fixture.a.userId]);
    const second = await postExpense(key).expect(200);
    const after = await pool.query(countTransactionsSql(), [fixture.a.userId]);

    expect(after.rows[0].n).toBe(before.rows[0].n);
    expect(second.body).toEqual(first.body);
  });

  it('T-A04 ❌: sin header Idempotency-Key → 400 IDEMPOTENCY_KEY_REQUIRED, cero filas', async () => {
    await expectRejection({
      perform: () => postExpense(undefined).expect(400),
      code: 'IDEMPOTENCY_KEY_REQUIRED',
      countQueries: [{ sql: countTransactionsSql(), params: [fixture.a.userId] }],
    });
  });

  it('T-A05 ❌: Idempotency-Key no es UUID → 400 IDEMPOTENCY_KEY_INVALID, cero filas', async () => {
    await expectRejection({
      perform: () => postExpense('not-a-uuid').expect(400),
      code: 'IDEMPOTENCY_KEY_INVALID',
      countQueries: [{ sql: countTransactionsSql(), params: [fixture.a.userId] }],
    });
  });

  it('T-A09: el header en GET /accounts → ignorado en silencio, 200 normal', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/accounts')
      .set('Authorization', authA)
      .set('Idempotency-Key', 'not-a-uuid-and-should-not-matter')
      .expect(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('T-A22: 409 IDEMPOTENCY_IN_FLIGHT provocado con Promise.all trae header Retry-After: 1', async () => {
    const key = randomUUID();

    const [resA, resB] = await Promise.all([postExpense(key), postExpense(key)]);
    const statuses = [resA.status, resB.status].sort();

    // Nunca dos 201 — mismo invariante que T-A07 de Grupo A-core, ahora a
    // nivel HTTP. La segunda es 200 (ya visible) o 409 (fila aún no COMMIT).
    expect(statuses[0]).not.toBe(201);
    expect([200, 201, 409]).toContain(resA.status);
    expect([200, 201, 409]).toContain(resB.status);
    expect(resA.status === 201 || resB.status === 201).toBe(true);

    const inFlight = [resA, resB].find((r) => r.status === 409);
    if (inFlight) {
      expect(inFlight.body.code).toBe('IDEMPOTENCY_IN_FLIGHT');
      expect(inFlight.headers['retry-after']).toBe('1');
    }
  });
});
