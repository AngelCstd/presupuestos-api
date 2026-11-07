import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { createTestApp, type TestAppHandle } from '../_helpers/app';
import { bearerFor } from '../_helpers/auth';
import { pool, seedFixtureCommitted, type Fixture } from '../_helpers/seed';
import { expectRejection, countTransactionsSql, countEntriesSql } from '../_helpers/reject';

// Grupo F — reversa (TASK-api.md §11, T-F01–F11). TransactionsModule no
// existe todavía — rojo por diseño. CategoriesModule sí existe (loop 1,
// A06) — T-F08 lo necesita real para archivar un sobre.
import { TransactionsModule } from '../../../../src/transactions/transactions.module';
import { CategoriesModule } from '../../../../src/categories/categories.module';
import { PrismaQueryRepository } from '../../../../src/shared/queries/repositories/prisma-query.repository';

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

describe('TransactionsModule — transactions-reversal.integration.spec.ts (Grupo F)', () => {
  let app: INestApplication;
  let handle: TestAppHandle;
  let fixture: Fixture;
  let authA: string;
  let authB: string;
  let queryRepository: PrismaQueryRepository;
  const prisma = new PrismaClient();

  beforeAll(async () => {
    fixture = await seedFixtureCommitted();
    authA = bearerFor(fixture.a.userId);
    authB = bearerFor(fixture.b.userId);

    handle = await createTestApp([TransactionsModule, CategoriesModule]);
    app = handle.app;
    queryRepository = new PrismaQueryRepository(prisma);
  });

  afterAll(async () => {
    await handle.close();
    await prisma.$disconnect();
    await pool.end();
  });

  function post(path: string, auth: string, body: Record<string, unknown>, idemKey = randomUUID()) {
    return request(app.getHttpServer())
      .post(path)
      .set('Authorization', auth)
      .set('Idempotency-Key', idemKey)
      .send(body);
  }

  async function createExpense(
    auth = authA,
    bookedAt = '2026-08-05',
    accounts: { paidFrom: string; category: string } = { paidFrom: fixture.a.accounts.tdc, category: fixture.a.accounts.comida },
  ): Promise<string> {
    const res = await post('/api/v1/transactions/expenses', auth, {
      bookedAt,
      description: 'Wifi agosto',
      paidFromAccountId: accounts.paidFrom,
      totalCents: '70000',
      lines: [{ categoryId: accounts.category, amountCents: '70000' }],
    }).expect(201);
    return res.body.id as string;
  }

  it('T-F01: reversa de un gasto TDC −70000/Comida +70000 → 201; entries invertidos; reversesTransactionId = original', async () => {
    const originalId = await createExpense();

    const res = await post(`/api/v1/transactions/${originalId}/reversal`, authA, {}).expect(201);
    expect(res.body.reversesTransactionId).toBe(originalId);

    const byAccount = amountByAccount(await entriesOf(res.body.id as string));
    expect(byAccount.get(fixture.a.accounts.tdc)).toBe(70000n);
    expect(byAccount.get(fixture.a.accounts.comida)).toBe(-70000n);
  });

  it('T-F02: tras la reversa, F1 — los saldos de TDC y Comida volvieron al valor previo al gasto', async () => {
    const before = await queryRepository.accountBalances(fixture.a.userId);
    const tdcBefore = before.find((b) => b.accountId === fixture.a.accounts.tdc)!.balanceCents;
    const comidaBefore = before.find((b) => b.accountId === fixture.a.accounts.comida)!.balanceCents;

    const originalId = await createExpense();
    await post(`/api/v1/transactions/${originalId}/reversal`, authA, {}).expect(201);

    const after = await queryRepository.accountBalances(fixture.a.userId);
    expect(after.find((b) => b.accountId === fixture.a.accounts.tdc)!.balanceCents).toBe(tdcBefore);
    expect(after.find((b) => b.accountId === fixture.a.accounts.comida)!.balanceCents).toBe(comidaBefore);
  });

  it('T-F03: bookedAt omitido en el body → la reversa hereda el bookedAt del original', async () => {
    const originalId = await createExpense(authA, '2026-08-03');
    const res = await post(`/api/v1/transactions/${originalId}/reversal`, authA, {}).expect(201);
    expect(res.body.bookedAt).toBe('2026-08-03');
  });

  it('T-F04: bookedAt explícito distinto → se respeta', async () => {
    const originalId = await createExpense(authA, '2026-08-03');
    const res = await post(`/api/v1/transactions/${originalId}/reversal`, authA, { bookedAt: '2026-08-09' }).expect(
      201,
    );
    expect(res.body.bookedAt).toBe('2026-08-09');
  });

  it('T-F05 ❌: segunda reversa de la misma transacción → 409 ALREADY_REVERSED, cero filas nuevas', async () => {
    const originalId = await createExpense();
    await post(`/api/v1/transactions/${originalId}/reversal`, authA, {}).expect(201);

    await expectRejection({
      perform: () => post(`/api/v1/transactions/${originalId}/reversal`, authA, {}).expect(409),
      code: 'ALREADY_REVERSED',
      countQueries: [
        { sql: countTransactionsSql(), params: [fixture.a.userId] },
        { sql: countEntriesSql(), params: [fixture.a.userId] },
      ],
    });
  });

  it('T-F06 ❌: reversa de una reversa → 409 CANNOT_REVERSE_REVERSAL (S-R7), cero filas nuevas', async () => {
    const originalId = await createExpense();
    const reversalRes = await post(`/api/v1/transactions/${originalId}/reversal`, authA, {}).expect(201);
    const reversalId = reversalRes.body.id as string;

    await expectRejection({
      perform: () => post(`/api/v1/transactions/${reversalId}/reversal`, authA, {}).expect(409),
      code: 'CANNOT_REVERSE_REVERSAL',
      countQueries: [
        { sql: countTransactionsSql(), params: [fixture.a.userId] },
        { sql: countEntriesSql(), params: [fixture.a.userId] },
      ],
    });
  });

  it('T-F07 ❌: reversa de una transacción de U2 estando autenticado como U1 → 404 TRANSACTION_NOT_FOUND', async () => {
    const originalId = await createExpense(authB, '2026-08-05', {
      paidFrom: fixture.b.accounts.tdc,
      category: fixture.b.accounts.comida,
    });

    await expectRejection({
      perform: () => post(`/api/v1/transactions/${originalId}/reversal`, authA, {}).expect(404),
      code: 'TRANSACTION_NOT_FOUND',
      countQueries: [{ sql: countTransactionsSql(), params: [fixture.a.userId] }],
    });
  });

  it('T-F08: reversa de una transacción cuya cuenta (sobre) fue archivada después → 201, S-R9 no aplica a reversas', async () => {
    const categoryRes = await request(app.getHttpServer())
      .post('/api/v1/categories')
      .set('Authorization', authA)
      .send({ name: 'Sobre F08', rolloverType: 'reset' })
      .expect(201);
    const categoryId = categoryRes.body.id as string;

    const originalRes = await post('/api/v1/transactions/expenses', authA, {
      bookedAt: '2026-08-05',
      description: 'gasto contra sobre F08',
      paidFromAccountId: fixture.a.accounts.tdc,
      totalCents: '15000',
      lines: [{ categoryId, amountCents: '15000' }],
    }).expect(201);

    // R8 exime a `expense` del saldo cero — se archiva con gasto acumulado.
    await request(app.getHttpServer())
      .post(`/api/v1/categories/${categoryId}/archive`)
      .set('Authorization', authA)
      .expect(200);

    const res = await post(`/api/v1/transactions/${originalRes.body.id}/reversal`, authA, {}).expect(201);
    const byAccount = amountByAccount(await entriesOf(res.body.id as string));
    expect(byAccount.get(categoryId)).toBe(-15000n);
  });

  it('T-F09 ❌: DELETE /transactions/{id} → 404, el verbo no existe (routing, no dominio)', async () => {
    const originalId = await createExpense();
    const before = await pool.query('SELECT count(*)::int AS n FROM transactions WHERE id = $1', [originalId]);
    expect(before.rows[0].n).toBe(1);

    await request(app.getHttpServer())
      .delete(`/api/v1/transactions/${originalId}`)
      .set('Authorization', authA)
      .expect(404);

    const after = await pool.query('SELECT count(*)::int AS n FROM transactions WHERE id = $1', [originalId]);
    expect(after.rows[0].n).toBe(1);
  });

  it('T-F10: PATCH /transactions/{id} con description → 200, descripción actualizada', async () => {
    const originalId = await createExpense();
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/transactions/${originalId}`)
      .set('Authorization', authA)
      .send({ description: 'Wifi agosto — Totalplay' })
      .expect(200);
    expect(res.body.description).toBe('Wifi agosto — Totalplay');
  });

  it('T-F11 ❌: PATCH /transactions/{id} con bookedAt → 400 VALIDATION_FAILED (forbidNonWhitelisted, nunca llega a R6)', async () => {
    const originalId = await createExpense(authA, '2026-08-05');
    const before = await pool.query('SELECT booked_at::text AS booked_at FROM transactions WHERE id = $1', [
      originalId,
    ]);
    expect(before.rows[0].booked_at).toBe('2026-08-05');

    const res = await request(app.getHttpServer())
      .patch(`/api/v1/transactions/${originalId}`)
      .set('Authorization', authA)
      .send({ bookedAt: '2026-08-01' })
      .expect(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');

    const after = await pool.query('SELECT booked_at::text AS booked_at FROM transactions WHERE id = $1', [
      originalId,
    ]);
    expect(after.rows[0].booked_at).toBe('2026-08-05');
  });
});
