import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { createTestApp, type TestAppHandle } from '../_helpers/app';
import { bearerFor } from '../_helpers/auth';
import { pool, seedFixtureCommitted, type Fixture } from '../_helpers/seed';
import { expectRejection, countTransactionsSql, countEntriesSql } from '../_helpers/reject';
import { insertAccount } from '../../../setup/fixture';

// Grupo B — gasto (TASK-api.md §11, T-B01–B14). TransactionsModule no
// existe todavía — rojo por diseño, igual que el resto de módulos de
// dominio en la sesión de tests de loop 1.
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

describe('TransactionsModule — transactions-expense.integration.spec.ts (Grupo B)', () => {
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

    handle = await createTestApp([TransactionsModule]);
    app = handle.app;
    queryRepository = new PrismaQueryRepository(prisma);
  });

  afterAll(async () => {
    await handle.close();
    await prisma.$disconnect();
    await pool.end();
  });

  function postExpense(auth: string, body: Record<string, unknown>, idemKey = randomUUID()) {
    return request(app.getHttpServer())
      .post('/api/v1/transactions/expenses')
      .set('Authorization', auth)
      .set('Idempotency-Key', idemKey)
      .send(body);
  }

  it('T-B01: paidFrom=TDC, total="70000", lines=[{Comida,"70000"}] → 201; entries TDC −70000, Comida +70000', async () => {
    const res = await postExpense(authA, {
      bookedAt: '2026-08-05',
      description: 'Wifi agosto',
      paidFromAccountId: fixture.a.accounts.tdc,
      totalCents: '70000',
      lines: [{ categoryId: fixture.a.accounts.comida, amountCents: '70000' }],
    }).expect(201);

    expect(res.body.totalCents).toBe('70000');
    const byAccount = amountByAccount(await entriesOf(res.body.id as string));
    expect(byAccount.get(fixture.a.accounts.tdc)).toBe(-70000n);
    expect(byAccount.get(fixture.a.accounts.comida)).toBe(70000n);
  });

  it('T-B02: total="80000", lines=[{Comida,"40000"}], lentTo=[{Fer,"40000"}] → 201; 3 entries; Fer = +40000', async () => {
    const res = await postExpense(authA, {
      bookedAt: '2026-08-05',
      description: 'Cena con Fer',
      paidFromAccountId: fixture.a.accounts.tdc,
      totalCents: '80000',
      lines: [{ categoryId: fixture.a.accounts.comida, amountCents: '40000' }],
      lentTo: [{ receivableAccountId: fixture.a.accounts.porCobrarFer, amountCents: '40000' }],
    }).expect(201);

    const rows = await entriesOf(res.body.id as string);
    expect(rows).toHaveLength(3);
    const byAccount = amountByAccount(rows);
    expect(byAccount.get(fixture.a.accounts.tdc)).toBe(-80000n);
    expect(byAccount.get(fixture.a.accounts.comida)).toBe(40000n);
    expect(byAccount.get(fixture.a.accounts.porCobrarFer)).toBe(40000n);
  });

  it('T-B03 ❌: total="80000" con partes que suman "70000" → 422 SPLIT_TOTAL_MISMATCH, cero filas', async () => {
    await expectRejection({
      perform: () =>
        postExpense(authA, {
          bookedAt: '2026-08-05',
          description: 'Split roto',
          paidFromAccountId: fixture.a.accounts.tdc,
          totalCents: '80000',
          lines: [{ categoryId: fixture.a.accounts.comida, amountCents: '70000' }],
        }).expect(422),
      code: 'SPLIT_TOTAL_MISMATCH',
      countQueries: [
        { sql: countTransactionsSql(), params: [fixture.a.userId] },
        { sql: countEntriesSql(), params: [fixture.a.userId] },
      ],
    });
  });

  it('T-B04 ❌: paidFrom = un sobre (expense) → 422 INVALID_ACCOUNT_ROLE, cero filas, ErrorLog sin ningún P1xxx', async () => {
    const before = await pool.query('SELECT count(*)::int AS n FROM error_log WHERE user_id = $1', [
      fixture.a.userId,
    ]);

    await expectRejection({
      perform: () =>
        postExpense(authA, {
          bookedAt: '2026-08-05',
          description: 'paidFrom inválido',
          paidFromAccountId: fixture.a.accounts.comida,
          totalCents: '10000',
          lines: [{ categoryId: fixture.a.accounts.transporte, amountCents: '10000' }],
        }).expect(422),
      code: 'INVALID_ACCOUNT_ROLE',
      countQueries: [
        { sql: countTransactionsSql(), params: [fixture.a.userId] },
        { sql: countEntriesSql(), params: [fixture.a.userId] },
      ],
    });

    // Positivo primero: el filtro sí registró algo para este rechazo —
    // después, y sólo después, la ausencia de P1xxx tiene sentido afirmar.
    const after = await pool.query('SELECT count(*)::int AS n FROM error_log WHERE user_id = $1', [
      fixture.a.userId,
    ]);
    expect(after.rows[0].n).toBeGreaterThan(before.rows[0].n);

    const newRows = await pool.query(
      'SELECT message FROM error_log WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2',
      [fixture.a.userId, after.rows[0].n - before.rows[0].n],
    );
    for (const row of newRows.rows as Array<{ message: string }>) {
      expect(row.message).not.toMatch(/P10(0[1-9]|1[01])/);
    }
  });

  it('T-B05 ❌: lines[].categoryId = una cuenta asset → 422 INVALID_ACCOUNT_ROLE', async () => {
    await expectRejection({
      perform: () =>
        postExpense(authA, {
          bookedAt: '2026-08-05',
          description: 'categoryId inválido',
          paidFromAccountId: fixture.a.accounts.tdc,
          totalCents: '10000',
          lines: [{ categoryId: fixture.a.accounts.nu, amountCents: '10000' }],
        }).expect(422),
      code: 'INVALID_ACCOUNT_ROLE',
      countQueries: [{ sql: countTransactionsSql(), params: [fixture.a.userId] }],
    });
  });

  it('T-B06 ❌: lentTo[].receivableAccountId = una cuenta asset → 422 INVALID_ACCOUNT_ROLE', async () => {
    await expectRejection({
      perform: () =>
        postExpense(authA, {
          bookedAt: '2026-08-05',
          description: 'lentTo inválido',
          paidFromAccountId: fixture.a.accounts.tdc,
          totalCents: '20000',
          lines: [{ categoryId: fixture.a.accounts.comida, amountCents: '10000' }],
          lentTo: [{ receivableAccountId: fixture.a.accounts.nu, amountCents: '10000' }],
        }).expect(422),
      code: 'INVALID_ACCOUNT_ROLE',
      countQueries: [{ sql: countTransactionsSql(), params: [fixture.a.userId] }],
    });
  });

  it('T-B07 ❌: paidFrom = la cuenta equity is_system → 403 SYSTEM_ACCOUNT_NOT_ADDRESSABLE', async () => {
    await expectRejection({
      perform: () =>
        postExpense(authA, {
          bookedAt: '2026-08-05',
          description: 'equity directo',
          paidFromAccountId: fixture.a.accounts.saldoInicial,
          totalCents: '10000',
          lines: [{ categoryId: fixture.a.accounts.comida, amountCents: '10000' }],
        }).expect(403),
      code: 'SYSTEM_ACCOUNT_NOT_ADDRESSABLE',
      countQueries: [{ sql: countTransactionsSql(), params: [fixture.a.userId] }],
    });
  });

  it('T-B08 ❌: paidFrom archivada → 409 ACCOUNT_ARCHIVED (S-R9)', async () => {
    const archivedId = randomUUID();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await insertAccount(client, {
        id: archivedId,
        userId: fixture.a.userId,
        name: 'Archivada B08',
        type: 'asset',
        archivedAt: new Date().toISOString(),
      });
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    await expectRejection({
      perform: () =>
        postExpense(authA, {
          bookedAt: '2026-08-05',
          description: 'cuenta archivada',
          paidFromAccountId: archivedId,
          totalCents: '10000',
          lines: [{ categoryId: fixture.a.accounts.comida, amountCents: '10000' }],
        }).expect(409),
      code: 'ACCOUNT_ARCHIVED',
      countQueries: [{ sql: countTransactionsSql(), params: [fixture.a.userId] }],
    });
  });

  it('T-B09 ❌: paidFrom en MXN, sobre en USD → 422 MIXED_CURRENCY, cero filas', async () => {
    const usdCategoryId = randomUUID();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await insertAccount(client, {
        id: usdCategoryId,
        userId: fixture.a.userId,
        name: 'Comida USD',
        type: 'expense',
        rolloverType: 'reset',
        currency: 'USD',
      });
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    await expectRejection({
      perform: () =>
        postExpense(authA, {
          bookedAt: '2026-08-05',
          description: 'monedas mezcladas',
          paidFromAccountId: fixture.a.accounts.tdc,
          totalCents: '10000',
          lines: [{ categoryId: usdCategoryId, amountCents: '10000' }],
        }).expect(422),
      code: 'MIXED_CURRENCY',
      countQueries: [
        { sql: countTransactionsSql(), params: [fixture.a.userId] },
        { sql: countEntriesSql(), params: [fixture.a.userId] },
      ],
    });
  });

  it('T-B10 ❌: paidFrom de U2 estando autenticado como U1 → 404 ACCOUNT_NOT_FOUND, nunca 403', async () => {
    await expectRejection({
      perform: () =>
        postExpense(authA, {
          bookedAt: '2026-08-05',
          description: 'cuenta ajena',
          paidFromAccountId: fixture.b.accounts.nu,
          totalCents: '10000',
          lines: [{ categoryId: fixture.a.accounts.comida, amountCents: '10000' }],
        }).expect(404),
      code: 'ACCOUNT_NOT_FOUND',
      countQueries: [{ sql: countTransactionsSql(), params: [fixture.a.userId] }],
    });
  });

  it('T-B11 ❌: total="-70000" → 400 VALIDATION_FAILED', async () => {
    await expectRejection({
      perform: () =>
        postExpense(authA, {
          bookedAt: '2026-08-05',
          description: 'monto negativo',
          paidFromAccountId: fixture.a.accounts.tdc,
          totalCents: '-70000',
          lines: [{ categoryId: fixture.a.accounts.comida, amountCents: '-70000' }],
        }).expect(400),
      code: 'VALIDATION_FAILED',
      countQueries: [{ sql: countTransactionsSql(), params: [fixture.a.userId] }],
    });
  });

  it('T-B12 ❌: bookedAt="09/08/2026" (formato inválido) → 400 VALIDATION_FAILED', async () => {
    await expectRejection({
      perform: () =>
        postExpense(authA, {
          bookedAt: '09/08/2026',
          description: 'fecha inválida',
          paidFromAccountId: fixture.a.accounts.tdc,
          totalCents: '10000',
          lines: [{ categoryId: fixture.a.accounts.comida, amountCents: '10000' }],
        }).expect(400),
      code: 'VALIDATION_FAILED',
      countQueries: [{ sql: countTransactionsSql(), params: [fixture.a.userId] }],
    });
  });

  it('T-B13: bookedAt dentro de un periodo cerrado → 201; el ledger nunca rechaza; aparece como sobregiro en F2 de ese periodo', async () => {
    const closedPeriodId = randomUUID();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Rango de julio, fuera del de p1/p2 (agosto) del fixture — evita
      // 23P01 (EXCLUDE de no-traslape, TASK-db.md R-periodo).
      await client.query(
        `INSERT INTO budget_periods (id, user_id, starts_on, ends_on, closed_at) VALUES ($1, $2, '2026-07-01', '2026-07-31', now())`,
        [closedPeriodId, fixture.a.userId],
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    const before = await queryRepository.categoryBalances(fixture.a.userId, closedPeriodId);
    const beforeSpent = before.find((c) => c.categoryId === fixture.a.accounts.transporte)?.spentCents ?? 0n;

    const res = await postExpense(authA, {
      bookedAt: '2026-07-15',
      description: 'gasto tardío sin captura de presupuesto',
      paidFromAccountId: fixture.a.accounts.tdc,
      totalCents: '5000',
      lines: [{ categoryId: fixture.a.accounts.transporte, amountCents: '5000' }],
    }).expect(201);
    expect(res.body.bookedAt).toBe('2026-07-15');

    const after = await queryRepository.categoryBalances(fixture.a.userId, closedPeriodId);
    const afterRow = after.find((c) => c.categoryId === fixture.a.accounts.transporte);
    expect(afterRow?.spentCents).toBe(beforeSpent + 5000n);
  });

  it('T-B14: bookedAt en un hueco entre periodos → 201; aparece en transactionsWithoutPeriod (F4)', async () => {
    // 2026-06-01 no cae en p1 (ago 1–15) ni p2 (ago 16–31) del fixture,
    // ni en ningún otro periodo sembrado por este archivo.
    const res = await postExpense(authA, {
      bookedAt: '2026-06-01',
      description: 'gasto en hueco',
      paidFromAccountId: fixture.a.accounts.tdc,
      totalCents: '3000',
      lines: [{ categoryId: fixture.a.accounts.hogar, amountCents: '3000' }],
    }).expect(201);

    const orphans = await queryRepository.transactionsWithoutPeriod(fixture.a.userId);
    expect(orphans.some((o) => o.transactionId === res.body.id)).toBe(true);
  });
});
