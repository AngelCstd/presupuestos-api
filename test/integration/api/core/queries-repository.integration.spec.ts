import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { PrismaClient } from '@prisma/client';
import { pool, seedFixtureCommitted, type Fixture } from '../_helpers/seed';
import { insertBalancedTransaction, insertBudgetEntry } from '../../../setup/ledger';

// Grupo O-core (TASK-api.md §11, agregado en esta sesión con Luis — sin
// IDs propios en la versión original del documento). Verifica el
// ENVOLTORIO de PrismaQueryRepository sobre F1-F4, no su aritmética — eso
// ya lo cubren los 123 tests de TASK-db. Los valores canónicos de
// unassignedFunds se reusan tal cual de ARCHITECTURE.md §3.9 / T-G14 /
// T-G16 de la capa de datos, no se recalculan.
import { PrismaQueryRepository } from '../../../../src/shared/queries/repositories/prisma-query.repository';

interface AccountBalanceRowLike {
  accountId: string;
  name: string;
  type: string;
  currency: string;
  balanceCents: bigint;
}

interface CategoryBalanceRowLike {
  categoryId: string;
  name: string;
  assignedCents: bigint;
  spentCents: bigint;
  availableCents: bigint;
  hasBudget: boolean;
}

interface OrphanTransactionRowLike {
  transactionId: string;
  bookedAt: unknown;
  description: string;
}

async function commitSetup(fn: (client: PoolClient) => Promise<void>): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await fn(client);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

describe('IQueryRepository — queries-repository.integration.spec.ts (Grupo O-core)', () => {
  const prisma = new PrismaClient();
  const repository = new PrismaQueryRepository(prisma);
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await seedFixtureCommitted();
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await pool.end();
  });

  it('T-OC01: accountBalances(A) — solo cuentas de A, forma correcta, balanceCents en bigint', async () => {
    const rows: AccountBalanceRowLike[] = await repository.accountBalances(fixture.a.userId);
    const bAccountIds = new Set(Object.values(fixture.b.accounts));

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => bAccountIds.has(r.accountId))).toBe(false);

    const nuRow = rows.find((r) => r.accountId === fixture.a.accounts.nu);
    expect(nuRow).toMatchObject({ accountId: fixture.a.accounts.nu, name: 'Nu', type: 'asset', currency: 'MXN' });
    expect(typeof nuRow!.balanceCents).toBe('bigint');
  });

  it('T-OC02: una cuenta archivada con saldo DISTINTO DE CERO sigue en accountBalances con su saldo real — S-R4, nunca filtra archived_at', async () => {
    // R8 es un TRIGGER de base de datos (TASK-db) — dispara sobre
    // cualquier UPDATE a archived_at con saldo ≠ 0, sin importar la capa
    // que lo emita. No hay forma de "saltárselo con SQL directo": hay que
    // pasar por él igual que lo haría el Service (financiar, drenar a
    // cero, archivar). Lo que SÍ es alcanzable a nivel repository es
    // fondear de nuevo DESPUÉS de archivar: S-R9 ("no escribir contra una
    // cuenta archivada") es una regla de SERVICE de esta tarea, no un
    // trigger de TASK-db — a nivel de SQL directo no hay nada que lo
    // impida. Es justo la vía que no existe todavía por HTTP sin una
    // reversa (A07, loop 2).
    const accountId = randomUUID();
    await pool.query(
      `INSERT INTO accounts (id, user_id, name, type) VALUES ($1, $2, 'T-OC02 test', 'asset')`,
      [accountId, fixture.a.userId],
    );

    await commitSetup(async (client) => {
      await insertBalancedTransaction(client, {
        userId: fixture.a.userId,
        bookedAt: '2026-08-09',
        entries: [
          { accountId, amountCents: 12345 },
          { accountId: fixture.a.accounts.comida, amountCents: -12345 },
        ],
      });
      // Drena a cero para poder archivar (R8 lo exige).
      await insertBalancedTransaction(client, {
        userId: fixture.a.userId,
        bookedAt: '2026-08-09',
        entries: [
          { accountId, amountCents: -12345 },
          { accountId: fixture.a.accounts.comida, amountCents: 12345 },
        ],
      });
    });

    await pool.query('UPDATE accounts SET archived_at = now() WHERE id = $1', [accountId]);

    // Ya archivada: un movimiento directo por SQL (S-R9 no es un trigger,
    // no lo bloquea) la deja con saldo distinto de cero.
    await commitSetup(async (client) => {
      await insertBalancedTransaction(client, {
        userId: fixture.a.userId,
        bookedAt: '2026-08-10',
        entries: [
          { accountId, amountCents: -12345 },
          { accountId: fixture.a.accounts.comida, amountCents: 12345 },
        ],
      });
    });

    const rows: AccountBalanceRowLike[] = await repository.accountBalances(fixture.a.userId);
    const row = rows.find((r) => r.accountId === accountId);
    expect(row).toBeDefined();
    expect(row?.balanceCents).toBe(-12345n);
  });

  it('T-OC03: categoryBalances(A, p1) — forma correcta, los tres montos en bigint', async () => {
    const rows: CategoryBalanceRowLike[] = await repository.categoryBalances(fixture.a.userId, fixture.a.periods.p1);

    expect(rows.length).toBeGreaterThan(0);
    const comida = rows.find((r) => r.categoryId === fixture.a.accounts.comida);
    expect(comida).toBeDefined();
    expect(typeof comida!.assignedCents).toBe('bigint');
    expect(typeof comida!.spentCents).toBe('bigint');
    expect(typeof comida!.availableCents).toBe('bigint');
    expect(typeof comida!.hasBudget).toBe('boolean');
  });

  it('T-OC04: dos asignaciones que cancelan (+50000/−50000) → assignedCents 0n PERO hasBudget:true', async () => {
    await commitSetup(async (client) => {
      await insertBudgetEntry(client, {
        userId: fixture.a.userId,
        periodId: fixture.a.periods.p2,
        categoryId: fixture.a.accounts.transporte,
        amountCents: 50_000,
      });
      await insertBudgetEntry(client, {
        userId: fixture.a.userId,
        periodId: fixture.a.periods.p2,
        categoryId: fixture.a.accounts.transporte,
        amountCents: -50_000,
      });
    });

    const rows: CategoryBalanceRowLike[] = await repository.categoryBalances(fixture.a.userId, fixture.a.periods.p2);
    const transporte = rows.find((r) => r.categoryId === fixture.a.accounts.transporte);

    expect(transporte?.assignedCents).toBe(0n);
    expect(transporte?.hasBudget).toBe(true);
  });

  it('T-OC05: unassignedFunds — ejemplo canónico #1 de §3.9 → 740000n directo, no arreglo', async () => {
    await commitSetup(async (client) => {
      await insertBalancedTransaction(client, {
        userId: fixture.a.userId,
        bookedAt: '2026-08-05',
        entries: [
          { accountId: fixture.a.accounts.nu, amountCents: 1_000_000 },
          { accountId: fixture.a.accounts.sueldo, amountCents: -1_000_000 },
        ],
      });
      await insertBudgetEntry(client, {
        userId: fixture.a.userId,
        periodId: fixture.a.periods.p1,
        categoryId: fixture.a.accounts.comida,
        amountCents: 200_000,
      });
      await insertBalancedTransaction(client, {
        userId: fixture.a.userId,
        bookedAt: '2026-08-05',
        entries: [
          { accountId: fixture.a.accounts.nu, amountCents: -50_000 },
          { accountId: fixture.a.accounts.comida, amountCents: 50_000 },
        ],
      });
      await insertBalancedTransaction(client, {
        userId: fixture.a.userId,
        bookedAt: '2026-08-06',
        entries: [
          { accountId: fixture.a.accounts.nu, amountCents: -30_000 },
          { accountId: fixture.a.accounts.salud, amountCents: 30_000 },
        ],
      });
    });

    const result = await repository.unassignedFunds(fixture.a.userId);

    expect(typeof result).toBe('bigint');
    expect(Array.isArray(result)).toBe(false);
    expect(result).toBe(740_000n);
  });

  it('T-OC06: unassignedFunds — ejemplo canónico #2 de §3.9, dos periodos abiertos → 1140000n', async () => {
    // Continúa sobre el estado de T-OC05 (mismo usuario, misma suite
    // --runInBand): agrega el ingreso y la segunda asignación que
    // convierten 740000n en 1140000n.
    await commitSetup(async (client) => {
      await insertBalancedTransaction(client, {
        userId: fixture.a.userId,
        bookedAt: '2026-08-20',
        entries: [
          { accountId: fixture.a.accounts.nu, amountCents: 500_000 },
          { accountId: fixture.a.accounts.sueldo, amountCents: -500_000 },
        ],
      });
      await insertBudgetEntry(client, {
        userId: fixture.a.userId,
        periodId: fixture.a.periods.p2,
        categoryId: fixture.a.accounts.comida,
        amountCents: 100_000,
      });
    });

    const result = await repository.unassignedFunds(fixture.a.userId);

    expect(result).toBe(1_140_000n);
  });

  it('T-OC07: transactionsWithoutPeriod — forma correcta, orden bookedAt DESC', async () => {
    let firstId = '';
    let secondId = '';
    await commitSetup(async (client) => {
      // Insertadas en orden NO cronológico a propósito, para que el
      // orden de la respuesta no sea un accidente del orden de inserción.
      const early = await insertBalancedTransaction(client, {
        userId: fixture.a.userId,
        bookedAt: '2026-07-01',
        description: 'fuera de todo periodo — antes',
        entries: [
          { accountId: fixture.a.accounts.nu, amountCents: -1000 },
          { accountId: fixture.a.accounts.comida, amountCents: 1000 },
        ],
      });
      firstId = early.transactionId;

      const late = await insertBalancedTransaction(client, {
        userId: fixture.a.userId,
        bookedAt: '2026-09-15',
        description: 'fuera de todo periodo — después',
        entries: [
          { accountId: fixture.a.accounts.nu, amountCents: -2000 },
          { accountId: fixture.a.accounts.comida, amountCents: 2000 },
        ],
      });
      secondId = late.transactionId;
    });

    const rows: OrphanTransactionRowLike[] = await repository.transactionsWithoutPeriod(fixture.a.userId);
    const ids = rows.map((r) => r.transactionId);

    expect(ids.indexOf(secondId)).toBeLessThan(ids.indexOf(firstId));
    const row = rows.find((r) => r.transactionId === secondId);
    expect(row).toMatchObject({ transactionId: secondId, description: 'fuera de todo periodo — después' });
    expect(row!.bookedAt).toBeDefined();
  });
});
