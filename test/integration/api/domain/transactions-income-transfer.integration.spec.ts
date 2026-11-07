import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { createTestApp, type TestAppHandle } from '../_helpers/app';
import { bearerFor } from '../_helpers/auth';
import { pool, seedFixtureCommitted, type Fixture } from '../_helpers/seed';
import { expectRejection, countTransactionsSql, countEntriesSql } from '../_helpers/reject';
import { insertAccount } from '../../../setup/fixture';

// Grupo C — ingreso y transferencia (TASK-api.md §11, T-C01–C07).
// TransactionsModule no existe todavía — rojo por diseño.
import { TransactionsModule } from '../../../../src/transactions/transactions.module';
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

describe('TransactionsModule — transactions-income-transfer.integration.spec.ts (Grupo C)', () => {
  let app: INestApplication;
  let handle: TestAppHandle;
  let fixture: Fixture;
  let authA: string;
  let efectivoId: string;
  let queryRepository: PrismaQueryRepository;
  const prisma = new PrismaClient();

  beforeAll(async () => {
    fixture = await seedFixtureCommitted();
    authA = bearerFor(fixture.a.userId);

    efectivoId = randomUUID();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await insertAccount(client, { id: efectivoId, userId: fixture.a.userId, name: 'Efectivo', type: 'asset' });
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    handle = await createTestApp([TransactionsModule]);
    app = handle.app;
    queryRepository = new PrismaQueryRepository(prisma);
  });

  afterAll(async () => {
    await handle.close();
    await prisma.$disconnect();
    await pool.end();
  });

  function postIncome(auth: string, body: Record<string, unknown>, idemKey = randomUUID()) {
    return request(app.getHttpServer())
      .post('/api/v1/transactions/incomes')
      .set('Authorization', auth)
      .set('Idempotency-Key', idemKey)
      .send(body);
  }

  function postTransfer(auth: string, body: Record<string, unknown>, idemKey = randomUUID()) {
    return request(app.getHttpServer())
      .post('/api/v1/transactions/transfers')
      .set('Authorization', auth)
      .set('Idempotency-Key', idemKey)
      .send(body);
  }

  it('T-C01: ingreso Nu ← Sueldo, "1000000" → 201; entries Nu +1000000, Sueldo −1000000', async () => {
    const res = await postIncome(authA, {
      bookedAt: '2026-08-05',
      description: 'Quincena agosto',
      toAccountId: fixture.a.accounts.nu,
      sourceId: fixture.a.accounts.sueldo,
      amountCents: '1000000',
    }).expect(201);

    const byAccount = amountByAccount(await entriesOf(res.body.id as string));
    expect(byAccount.get(fixture.a.accounts.nu)).toBe(1000000n);
    expect(byAccount.get(fixture.a.accounts.sueldo)).toBe(-1000000n);
  });

  it('T-C02 ❌: sourceId = una cuenta asset → 422 INVALID_ACCOUNT_ROLE', async () => {
    await expectRejection({
      perform: () =>
        postIncome(authA, {
          bookedAt: '2026-08-05',
          description: 'sourceId inválido',
          toAccountId: fixture.a.accounts.nu,
          sourceId: fixture.a.accounts.tdc,
          amountCents: '10000',
        }).expect(422),
      code: 'INVALID_ACCOUNT_ROLE',
      countQueries: [{ sql: countTransactionsSql(), params: [fixture.a.userId] }],
    });
  });

  it('T-C03 ❌: toAccountId = un sobre → 422 INVALID_ACCOUNT_ROLE', async () => {
    await expectRejection({
      perform: () =>
        postIncome(authA, {
          bookedAt: '2026-08-05',
          description: 'toAccountId inválido',
          toAccountId: fixture.a.accounts.comida,
          sourceId: fixture.a.accounts.sueldo,
          amountCents: '10000',
        }).expect(422),
      code: 'INVALID_ACCOUNT_ROLE',
      countQueries: [{ sql: countTransactionsSql(), params: [fixture.a.userId] }],
    });
  });

  it('T-C04: transferencia Nu → TDC "70000" (pago de tarjeta) → 201; cero entries contra cuentas expense', async () => {
    const res = await postTransfer(authA, {
      bookedAt: '2026-08-05',
      description: 'Pago tarjeta',
      fromAccountId: fixture.a.accounts.nu,
      toAccountId: fixture.a.accounts.tdc,
      amountCents: '70000',
    }).expect(201);

    const rows = await entriesOf(res.body.id as string);
    expect(rows).toHaveLength(2);
    const byAccount = amountByAccount(rows);
    expect(byAccount.get(fixture.a.accounts.nu)).toBe(-70000n);
    expect(byAccount.get(fixture.a.accounts.tdc)).toBe(70000n);
    const expenseAccountIds = new Set([
      fixture.a.accounts.comida,
      fixture.a.accounts.transporte,
      fixture.a.accounts.servicios,
      fixture.a.accounts.hogar,
      fixture.a.accounts.salud,
      fixture.a.accounts.personal,
      fixture.a.accounts.ahorro,
    ]);
    expect(rows.some((r) => expenseAccountIds.has(r.account_id))).toBe(false);
  });

  it('T-C05 ❌: transferencia con toAccountId = un sobre → 422 INVALID_ACCOUNT_ROLE (el error más común del dominio)', async () => {
    await expectRejection({
      perform: () =>
        postTransfer(authA, {
          bookedAt: '2026-08-05',
          description: 'pago tarjeta mal contabilizado',
          fromAccountId: fixture.a.accounts.nu,
          toAccountId: fixture.a.accounts.comida,
          amountCents: '10000',
        }).expect(422),
      code: 'INVALID_ACCOUNT_ROLE',
      countQueries: [{ sql: countTransactionsSql(), params: [fixture.a.userId] }],
    });
  });

  it('T-C06 ❌: from === to → 422 SAME_ACCOUNT_TRANSFER', async () => {
    await expectRejection({
      perform: () =>
        postTransfer(authA, {
          bookedAt: '2026-08-05',
          description: 'misma cuenta',
          fromAccountId: fixture.a.accounts.nu,
          toAccountId: fixture.a.accounts.nu,
          amountCents: '10000',
        }).expect(422),
      code: 'SAME_ACCOUNT_TRANSFER',
      countQueries: [{ sql: countTransactionsSql(), params: [fixture.a.userId] }],
    });
  });

  it('T-C07: transferencia Nu → Efectivo → 201; F3 (unassigned_funds) no cambia — mover entre asset no altera lo asignable', async () => {
    const before = await queryRepository.unassignedFunds(fixture.a.userId);

    await postTransfer(authA, {
      bookedAt: '2026-08-05',
      description: 'a efectivo',
      fromAccountId: fixture.a.accounts.nu,
      toAccountId: efectivoId,
      amountCents: '5000',
    }).expect(201);

    const after = await queryRepository.unassignedFunds(fixture.a.userId);
    expect(after).toBe(before);
  });
});
