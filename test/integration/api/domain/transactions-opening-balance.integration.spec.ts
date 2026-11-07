import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { createTestApp, type TestAppHandle } from '../_helpers/app';
import { bearerFor } from '../_helpers/auth';
import { pool, seedFixtureCommitted, type Fixture } from '../_helpers/seed';
import { expectRejection, countTransactionsSql, countEntriesSql } from '../_helpers/reject';
import { insertAccount } from '../../../setup/fixture';

// Grupo E — saldo inicial (TASK-api.md §11, T-E01–E08). TransactionsModule
// no existe todavía — rojo por diseño. AccountsModule sí existe (loop 1,
// A05) — T-E08 lo necesita real para verificar GET /accounts.
import { TransactionsModule } from '../../../../src/transactions/transactions.module';
import { AccountsModule } from '../../../../src/accounts/accounts.module';

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

async function newAccount(userId: string, name: string, type: string, currency = 'MXN'): Promise<string> {
  const id = randomUUID();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await insertAccount(client, { id, userId, name, type, currency });
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  return id;
}

describe('TransactionsModule — transactions-opening-balance.integration.spec.ts (Grupo E)', () => {
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

  function postOpeningBalances(auth: string, body: Record<string, unknown>, idemKey = randomUUID()) {
    return request(app.getHttpServer())
      .post('/api/v1/transactions/opening-balances')
      .set('Authorization', auth)
      .set('Idempotency-Key', idemKey)
      .send(body);
  }

  it('T-E01: [{Nu,"1000000"},{TDC,"-250000"},{Efectivo,"80000"}] → 201; 4 entries; equity = −830000', async () => {
    const nu = await newAccount(fixture.a.userId, 'Nu E01', 'asset');
    const tdc = await newAccount(fixture.a.userId, 'TDC E01', 'liability');
    const efectivo = await newAccount(fixture.a.userId, 'Efectivo E01', 'asset');

    const res = await postOpeningBalances(authA, {
      bookedAt: '2026-07-14',
      description: 'Saldos iniciales',
      balances: [
        { accountId: nu, balanceCents: '1000000' },
        { accountId: tdc, balanceCents: '-250000' },
        { accountId: efectivo, balanceCents: '80000' },
      ],
    }).expect(201);

    const rows = await entriesOf(res.body.id as string);
    expect(rows).toHaveLength(4);
    const byAccount = amountByAccount(rows);
    expect(byAccount.get(nu)).toBe(1000000n);
    expect(byAccount.get(tdc)).toBe(-250000n);
    expect(byAccount.get(efectivo)).toBe(80000n);
    expect(byAccount.get(fixture.a.accounts.saldoInicial)).toBe(-830000n);
  });

  it('T-E02: [{Nu,"1000"},{TDC,"-1000"}] → 201; 2 entries; ninguno contra equity (residual 0)', async () => {
    const nu = await newAccount(fixture.a.userId, 'Nu E02', 'asset');
    const tdc = await newAccount(fixture.a.userId, 'TDC E02', 'liability');

    const res = await postOpeningBalances(authA, {
      bookedAt: '2026-07-14',
      description: 'Saldos que cuadran',
      balances: [
        { accountId: nu, balanceCents: '1000' },
        { accountId: tdc, balanceCents: '-1000' },
      ],
    }).expect(201);

    const rows = await entriesOf(res.body.id as string);
    expect(rows).toHaveLength(2);
    expect(rows.some((r) => r.account_id === fixture.a.accounts.saldoInicial)).toBe(false);
  });

  it('T-E03: [{Nu,"1000"},{Efectivo,"0"}] → 201; 2 entries; el saldo cero se descartó', async () => {
    const nu = await newAccount(fixture.a.userId, 'Nu E03', 'asset');
    const efectivo = await newAccount(fixture.a.userId, 'Efectivo E03', 'asset');

    const res = await postOpeningBalances(authA, {
      bookedAt: '2026-07-14',
      description: 'con un cero',
      balances: [
        { accountId: nu, balanceCents: '1000' },
        { accountId: efectivo, balanceCents: '0' },
      ],
    }).expect(201);

    const rows = await entriesOf(res.body.id as string);
    expect(rows).toHaveLength(2);
    const byAccount = amountByAccount(rows);
    expect(byAccount.get(nu)).toBe(1000n);
    expect(byAccount.has(efectivo)).toBe(false);
    expect(byAccount.get(fixture.a.accounts.saldoInicial)).toBe(-1000n);
  });

  it('T-E04 ❌: [{Nu,"0"}] → 422 EMPTY_OPENING_BALANCE, cero filas', async () => {
    const nu = await newAccount(fixture.a.userId, 'Nu E04', 'asset');

    await expectRejection({
      perform: () =>
        postOpeningBalances(authA, {
          bookedAt: '2026-07-14',
          description: 'todo en cero',
          balances: [{ accountId: nu, balanceCents: '0' }],
        }).expect(422),
      code: 'EMPTY_OPENING_BALANCE',
      countQueries: [
        { sql: countTransactionsSql(), params: [fixture.a.userId] },
        { sql: countEntriesSql(), params: [fixture.a.userId] },
      ],
    });
  });

  it('T-E05 ❌: [{Comida,"1000"}] (un sobre) → 422 INVALID_ACCOUNT_ROLE', async () => {
    await expectRejection({
      perform: () =>
        postOpeningBalances(authA, {
          bookedAt: '2026-07-14',
          description: 'sobre como cuenta',
          balances: [{ accountId: fixture.a.accounts.comida, balanceCents: '1000' }],
        }).expect(422),
      code: 'INVALID_ACCOUNT_ROLE',
      countQueries: [{ sql: countTransactionsSql(), params: [fixture.a.userId] }],
    });
  });

  it('T-E06 ❌: un accountId = la cuenta equity → 403 SYSTEM_ACCOUNT_NOT_ADDRESSABLE', async () => {
    await expectRejection({
      perform: () =>
        postOpeningBalances(authA, {
          bookedAt: '2026-07-14',
          description: 'equity directo',
          balances: [{ accountId: fixture.a.accounts.saldoInicial, balanceCents: '1000' }],
        }).expect(403),
      code: 'SYSTEM_ACCOUNT_NOT_ADDRESSABLE',
      countQueries: [{ sql: countTransactionsSql(), params: [fixture.a.userId] }],
    });
  });

  it('T-E07: segunda invocación meses después, con una cuenta nueva → 201, se permite más de una vez', async () => {
    const first = await newAccount(fixture.a.userId, 'Nu E07', 'asset');
    await postOpeningBalances(authA, {
      bookedAt: '2026-07-14',
      description: 'primer onboarding',
      balances: [{ accountId: first, balanceCents: '1000' }],
    }).expect(201);

    const second = await newAccount(fixture.a.userId, 'Efectivo E07', 'asset');
    const res = await postOpeningBalances(authA, {
      bookedAt: '2027-01-10',
      description: 'cuenta agregada después',
      balances: [{ accountId: second, balanceCents: '2000' }],
    }).expect(201);

    const byAccount = amountByAccount(await entriesOf(res.body.id as string));
    expect(byAccount.get(second)).toBe(2000n);
  });

  it('T-E08: la cuenta equity nunca aparece en GET /accounts, ni antes ni después de un saldo inicial', async () => {
    const before = await request(app.getHttpServer()).get('/api/v1/accounts?pageSize=200').set('Authorization', authA);
    expect(before.status).toBe(200);
    expect(before.body.data.some((a: { id: string }) => a.id === fixture.a.accounts.saldoInicial)).toBe(false);

    const nu = await newAccount(fixture.a.userId, 'Nu E08', 'asset');
    await postOpeningBalances(authA, {
      bookedAt: '2026-07-14',
      description: 'saldo E08',
      balances: [{ accountId: nu, balanceCents: '5000' }],
    }).expect(201);

    const after = await request(app.getHttpServer()).get('/api/v1/accounts?pageSize=200').set('Authorization', authA);
    expect(after.status).toBe(200);
    expect(after.body.data.some((a: { id: string }) => a.id === fixture.a.accounts.saldoInicial)).toBe(false);
  });
});
