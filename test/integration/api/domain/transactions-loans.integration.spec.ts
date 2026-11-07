import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { createTestApp, type TestAppHandle } from '../_helpers/app';
import { bearerFor } from '../_helpers/auth';
import { pool, seedFixtureCommitted, type Fixture } from '../_helpers/seed';
import { expectRejection, countTransactionsSql, countEntriesSql } from '../_helpers/reject';
import { insertAccount } from '../../../setup/fixture';

// Grupo D — préstamos (TASK-api.md §11, T-D01–D08). TransactionsModule no
// existe todavía — rojo por diseño.
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

/** Recorre `src/` (no `test/`, no `node_modules/`) buscando el literal dado. */
function grepSrcFor(literal: string): string[] {
  const hits: string[] = [];
  const root = join(__dirname, '../../../../src');

  function walk(dir: string): void {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (full.endsWith('.ts')) {
        if (readFileSync(full, 'utf8').includes(literal)) {
          hits.push(full);
        }
      }
    }
  }

  walk(root);
  return hits;
}

describe('TransactionsModule — transactions-loans.integration.spec.ts (Grupo D)', () => {
  let app: INestApplication;
  let handle: TestAppHandle;
  let fixture: Fixture;
  let authA: string;
  let queryRepository: PrismaQueryRepository;
  const prisma = new PrismaClient();

  beforeAll(async () => {
    fixture = await seedFixtureCommitted();
    authA = bearerFor(fixture.a.userId);

    handle = await createTestApp([TransactionsModule]);
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
      .post(`/api/v1/transactions/${path}`)
      .set('Authorization', auth)
      .set('Idempotency-Key', idemKey)
      .send(body);
  }

  // T-D01–T-D03 comparten una sola cuenta receivable a propósito: T-D02 y
  // T-D03 verifican DELTAS relativos a lo que hizo T-D01, en ese orden.
  let chainReceivableId: string;
  let unassignedBeforeLoan: bigint;

  it('T-D01: préstamo Nu → Fer de "50000" → 201; Nu −50000, Fer +50000; cero entries contra expense', async () => {
    chainReceivableId = await newReceivable(fixture.a.userId, 'Fer D01-D03');
    unassignedBeforeLoan = await queryRepository.unassignedFunds(fixture.a.userId);

    const res = await post(
      'loans',
      authA,
      {
        bookedAt: '2026-08-05',
        description: 'Préstamo a Fer',
        fromAccountId: fixture.a.accounts.nu,
        receivableAccountId: chainReceivableId,
        amountCents: '50000',
      },
    ).expect(201);

    const rows = await entriesOf(res.body.id as string);
    expect(rows).toHaveLength(2);
    const byAccount = amountByAccount(rows);
    expect(byAccount.get(fixture.a.accounts.nu)).toBe(-50000n);
    expect(byAccount.get(chainReceivableId)).toBe(50000n);
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

  it('T-D02: tras T-D01, GET unassignedFunds (F3) bajó exactamente 50000 — receivable no cuenta en dinero_real', async () => {
    const after = await queryRepository.unassignedFunds(fixture.a.userId);
    expect(unassignedBeforeLoan - after).toBe(50000n);
  });

  it('T-D03: cobro Fer → Nu de "50000" → 201; saldo de Fer en 0; F3 vuelve al valor previo a T-D01', async () => {
    const res = await post(
      'loan-repayments',
      authA,
      {
        bookedAt: '2026-08-06',
        description: 'Fer me pagó',
        receivableAccountId: chainReceivableId,
        toAccountId: fixture.a.accounts.nu,
        amountCents: '50000',
      },
    ).expect(201);

    const byAccount = amountByAccount(await entriesOf(res.body.id as string));
    expect(byAccount.get(fixture.a.accounts.nu)).toBe(50000n);
    expect(byAccount.get(chainReceivableId)).toBe(-50000n);

    const balances = await queryRepository.accountBalances(fixture.a.userId);
    expect(balances.find((b) => b.accountId === chainReceivableId)?.balanceCents).toBe(0n);

    const unassignedAfter = await queryRepository.unassignedFunds(fixture.a.userId);
    expect(unassignedAfter).toBe(unassignedBeforeLoan);
  });

  it('T-D04: cobro parcial de "20000" sobre un préstamo de "50000" → 201, permitido, saldo queda en 30000', async () => {
    const receivableId = await newReceivable(fixture.a.userId, 'Fer D04');
    await post(
      'loans',
      authA,
      {
        bookedAt: '2026-08-05',
        description: 'Préstamo D04',
        fromAccountId: fixture.a.accounts.nu,
        receivableAccountId: receivableId,
        amountCents: '50000',
      },
    ).expect(201);

    await post(
      'loan-repayments',
      authA,
      {
        bookedAt: '2026-08-06',
        description: 'cobro parcial D04',
        receivableAccountId: receivableId,
        toAccountId: fixture.a.accounts.nu,
        amountCents: '20000',
      },
    ).expect(201);

    const balances = await queryRepository.accountBalances(fixture.a.userId);
    expect(balances.find((b) => b.accountId === receivableId)?.balanceCents).toBe(30000n);
  });

  it('T-D05: cobro de "80000" sobre un préstamo de "50000" → 201, Fer queda en −30000, no se bloquea', async () => {
    const receivableId = await newReceivable(fixture.a.userId, 'Fer D05');
    await post(
      'loans',
      authA,
      {
        bookedAt: '2026-08-05',
        description: 'Préstamo D05',
        fromAccountId: fixture.a.accounts.nu,
        receivableAccountId: receivableId,
        amountCents: '50000',
      },
    ).expect(201);

    await post(
      'loan-repayments',
      authA,
      {
        bookedAt: '2026-08-06',
        description: 'sobrecobro D05',
        receivableAccountId: receivableId,
        toAccountId: fixture.a.accounts.nu,
        amountCents: '80000',
      },
    ).expect(201);

    const balances = await queryRepository.accountBalances(fixture.a.userId);
    expect(balances.find((b) => b.accountId === receivableId)?.balanceCents).toBe(-30000n);
  });

  it('T-D06: incobrable Fer → sobre de "50000" → 201; Fer −50000, sobre +50000; aparece en F2 del periodo del bookedAt', async () => {
    const receivableId = await newReceivable(fixture.a.userId, 'Fer D06');
    await post(
      'loans',
      authA,
      {
        bookedAt: '2026-08-05',
        description: 'Préstamo D06',
        fromAccountId: fixture.a.accounts.nu,
        receivableAccountId: receivableId,
        amountCents: '50000',
      },
    ).expect(201);

    const before = await queryRepository.categoryBalances(fixture.a.userId, fixture.a.periods.p1);
    const beforeSpent = before.find((c) => c.categoryId === fixture.a.accounts.personal)?.spentCents ?? 0n;

    const res = await post(
      'loan-write-offs',
      authA,
      {
        bookedAt: '2026-08-07',
        description: 'Fer no va a pagar',
        receivableAccountId: receivableId,
        categoryId: fixture.a.accounts.personal,
        amountCents: '50000',
      },
    ).expect(201);

    const byAccount = amountByAccount(await entriesOf(res.body.id as string));
    expect(byAccount.get(receivableId)).toBe(-50000n);
    expect(byAccount.get(fixture.a.accounts.personal)).toBe(50000n);

    const after = await queryRepository.categoryBalances(fixture.a.userId, fixture.a.periods.p1);
    const afterSpent = after.find((c) => c.categoryId === fixture.a.accounts.personal)?.spentCents ?? 0n;
    expect(afterSpent - beforeSpent).toBe(50000n);
  });

  it('T-D07 ❌: incobrable con categoryId = una cuenta asset → 422 INVALID_ACCOUNT_ROLE', async () => {
    const receivableId = await newReceivable(fixture.a.userId, 'Fer D07');
    await expectRejection({
      perform: () =>
        post(
          'loan-write-offs',
          authA,
          {
            bookedAt: '2026-08-07',
            description: 'categoryId inválido',
            receivableAccountId: receivableId,
            categoryId: fixture.a.accounts.nu,
            amountCents: '10000',
          },
        ).expect(422),
      code: 'INVALID_ACCOUNT_ROLE',
      countQueries: [
        { sql: countTransactionsSql(), params: [fixture.a.userId] },
        { sql: countEntriesSql(), params: [fixture.a.userId] },
      ],
    });
  });

  it("T-D08 ❌: el literal 'Pérdidas'/'Perdidas' no aparece en ningún archivo de src/ — P-03 sigue abierto", () => {
    // Positivo primero: el barrido sí encuentra archivos .ts reales en src/
    // (si src/ estuviera vacío, la ausencia de abajo sería vacua).
    const allTsFiles = grepSrcFor('');
    expect(allTsFiles.length).toBeGreaterThan(0);

    expect(grepSrcFor('Pérdidas')).toEqual([]);
    expect(grepSrcFor('Perdidas')).toEqual([]);
  });
});
