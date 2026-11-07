import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { closePool, withRollback } from '../setup/db';
import { insertAccount, insertPeriod, seedFixture } from '../setup/fixture';
import { insertBalancedTransaction, insertBudgetEntry } from '../setup/ledger';

/**
 * F2/F3/F4 no traen un `CREATE FUNCTION` exacto en ARCHITECTURE.md (solo
 * F1 lo tiene, §3.9) — únicamente la firma de parámetros y la descripción
 * en prosa de qué devuelven. Los nombres de columna usados aquí
 * (`assigned_cents`/`spent_cents`/`available_cents`/`has_budget` para F2,
 * `unassigned_cents` para F3, `transaction_id`/`booked_at` para F4) son
 * una convención razonable siguiendo el estilo de F1, NO un contrato
 * documentado — si el loop las nombra distinto, hay que alinear estos
 * tests con la implementación real, no al revés.
 */
describe('Grupo G — funciones de consulta F1-F4 (U16-U19)', () => {
  afterAll(async () => {
    await closePool();
  });

  async function accountBalances(client: PoolClient, userId: string) {
    const { rows } = await client.query(
      'SELECT account_id, name, type, currency, balance_cents FROM fn_account_balances($1)',
      [userId],
    );
    return rows as Array<{ account_id: string; name: string; type: string; currency: string; balance_cents: number }>;
  }

  async function categoryBalance(client: PoolClient, userId: string, periodId: string, categoryId: string) {
    const { rows } = await client.query(
      'SELECT * FROM fn_category_balances($1, $2) WHERE category_id = $3',
      [userId, periodId, categoryId],
    );
    return rows[0] as
      | { category_id: string; assigned_cents: number; spent_cents: number; available_cents: number; has_budget: boolean }
      | undefined;
  }

  async function unassignedFunds(client: PoolClient, userId: string): Promise<number> {
    const { rows } = await client.query('SELECT unassigned_cents FROM fn_unassigned_funds($1)', [userId]);
    return rows[0]?.unassigned_cents as number;
  }

  async function transactionsWithoutPeriod(client: PoolClient, userId: string): Promise<string[]> {
    const { rows } = await client.query('SELECT transaction_id FROM fn_transactions_without_period($1)', [userId]);
    return rows.map((r: { transaction_id: string }) => r.transaction_id);
  }

  async function spend(
    client: PoolClient,
    userId: string,
    fromAccountId: string,
    categoryId: string,
    amountCents: number,
    bookedAt: string,
  ) {
    await insertBalancedTransaction(client, {
      userId,
      bookedAt,
      entries: [
        { accountId: fromAccountId, amountCents: -amountCents },
        { accountId: categoryId, amountCents },
      ],
    });
  }

  it('T-G01: cuenta creada, sin entries → fila presente con balance_cents = 0', async () => {
    await withRollback(async (client) => {
      const { a } = await seedFixture(client);
      const balances = await accountBalances(client, a.userId);
      const nu = balances.find((r) => r.account_id === a.accounts.nu);
      expect(nu).toBeDefined();
      expect(nu?.balance_cents).toBe(0);
    });
  });

  it('T-G02: los nueve casos canónicos de §3.2 → saldos exactos, incluido el préstamo incobrable', async () => {
    await withRollback(async (client) => {
      const { a } = await seedFixture(client);
      const acc = (name: string, type: string, extra: { rolloverType?: string; isSystem?: boolean } = {}) =>
        insertAccount(client, { id: randomUUID(), userId: a.userId, name, type, ...extra }).then(() => name);

      // 1. Ingreso de nómina $10,000
      const nu1 = randomUUID();
      const sueldo1 = randomUUID();
      await insertAccount(client, { id: nu1, userId: a.userId, name: 'Nu-1', type: 'asset' });
      await insertAccount(client, { id: sueldo1, userId: a.userId, name: 'Sueldo-1', type: 'income' });
      const nomina = await insertBalancedTransaction(client, {
        userId: a.userId,
        bookedAt: '2026-08-05',
        entries: [
          { accountId: nu1, amountCents: 1_000_000 },
          { accountId: sueldo1, amountCents: -1_000_000 },
        ],
      });

      // 2. Wifi $700 pagado con TDC
      const tdc2 = randomUUID();
      const wifi2 = randomUUID();
      await insertAccount(client, { id: tdc2, userId: a.userId, name: 'TDC-2', type: 'liability' });
      await insertAccount(client, { id: wifi2, userId: a.userId, name: 'Wifi', type: 'expense', rolloverType: 'reset' });
      await insertBalancedTransaction(client, {
        userId: a.userId,
        bookedAt: '2026-08-05',
        entries: [
          { accountId: tdc2, amountCents: -70_000 },
          { accountId: wifi2, amountCents: 70_000 },
        ],
      });

      // 3. Pago de tarjeta $700 desde Nu
      const nu3 = randomUUID();
      const tdc3 = randomUUID();
      await insertAccount(client, { id: nu3, userId: a.userId, name: 'Nu-3', type: 'asset' });
      await insertAccount(client, { id: tdc3, userId: a.userId, name: 'TDC-3', type: 'liability' });
      await insertBalancedTransaction(client, {
        userId: a.userId,
        bookedAt: '2026-08-05',
        entries: [
          { accountId: nu3, amountCents: -70_000 },
          { accountId: tdc3, amountCents: 70_000 },
        ],
      });

      // 4 + 5. Préstamo de $500 y su cobro
      const nu45 = randomUUID();
      const porCobrar45 = randomUUID();
      await insertAccount(client, { id: nu45, userId: a.userId, name: 'Nu-45', type: 'asset' });
      await insertAccount(client, { id: porCobrar45, userId: a.userId, name: 'Por cobrar-45', type: 'receivable' });
      await insertBalancedTransaction(client, {
        userId: a.userId,
        bookedAt: '2026-08-05',
        entries: [
          { accountId: nu45, amountCents: -50_000 },
          { accountId: porCobrar45, amountCents: 50_000 },
        ],
      });
      await insertBalancedTransaction(client, {
        userId: a.userId,
        bookedAt: '2026-08-06',
        entries: [
          { accountId: nu45, amountCents: 50_000 },
          { accountId: porCobrar45, amountCents: -50_000 },
        ],
      });

      // 6. Cena $800 con TDC, mitad prestada
      const tdc6 = randomUUID();
      const comida6 = randomUUID();
      const porCobrar6 = randomUUID();
      await insertAccount(client, { id: tdc6, userId: a.userId, name: 'TDC-6', type: 'liability' });
      await insertAccount(client, { id: comida6, userId: a.userId, name: 'Comida-6', type: 'expense', rolloverType: 'reset' });
      await insertAccount(client, { id: porCobrar6, userId: a.userId, name: 'Por cobrar-6', type: 'receivable' });
      await insertBalancedTransaction(client, {
        userId: a.userId,
        bookedAt: '2026-08-05',
        entries: [
          { accountId: tdc6, amountCents: -80_000 },
          { accountId: comida6, amountCents: 40_000 },
          { accountId: porCobrar6, amountCents: 40_000 },
        ],
      });

      // 7. Préstamo incobrable de $500: primero el préstamo, luego el castigo
      const nu7 = randomUUID();
      const porCobrar7 = randomUUID();
      const perdidas7 = randomUUID();
      await insertAccount(client, { id: nu7, userId: a.userId, name: 'Nu-7', type: 'asset' });
      await insertAccount(client, { id: porCobrar7, userId: a.userId, name: 'Por cobrar-7', type: 'receivable' });
      await insertAccount(client, { id: perdidas7, userId: a.userId, name: 'Pérdidas', type: 'expense', rolloverType: 'reset' });
      await insertBalancedTransaction(client, {
        userId: a.userId,
        bookedAt: '2026-08-01',
        entries: [
          { accountId: nu7, amountCents: -50_000 },
          { accountId: porCobrar7, amountCents: 50_000 },
        ],
      });
      await insertBalancedTransaction(client, {
        userId: a.userId,
        bookedAt: '2026-08-10',
        entries: [
          { accountId: porCobrar7, amountCents: -50_000 },
          { accountId: perdidas7, amountCents: 50_000 },
        ],
      });

      // 8. Saldo inicial (onboarding)
      const nu8 = randomUUID();
      const tdc8 = randomUUID();
      const efectivo8 = randomUUID();
      const saldoInicial8 = randomUUID();
      await insertAccount(client, { id: nu8, userId: a.userId, name: 'Nu-8', type: 'asset' });
      await insertAccount(client, { id: tdc8, userId: a.userId, name: 'TDC-8', type: 'liability' });
      await insertAccount(client, { id: efectivo8, userId: a.userId, name: 'Efectivo-8', type: 'asset' });
      await insertAccount(client, { id: saldoInicial8, userId: a.userId, name: 'SaldoInicial-8', type: 'equity', isSystem: true });
      await insertBalancedTransaction(client, {
        userId: a.userId,
        bookedAt: '2026-08-01',
        entries: [
          { accountId: nu8, amountCents: 1_000_000 },
          { accountId: tdc8, amountCents: -250_000 },
          { accountId: efectivo8, amountCents: 80_000 },
          { accountId: saldoInicial8, amountCents: -830_000 },
        ],
      });

      // 9. Reversa de la transacción #1 (nómina)
      await insertBalancedTransaction(client, {
        userId: a.userId,
        bookedAt: '2026-08-07',
        reversesTransactionId: nomina.transactionId,
        entries: [
          { accountId: nu1, amountCents: -1_000_000 },
          { accountId: sueldo1, amountCents: 1_000_000 },
        ],
      });

      const balances = await accountBalances(client, a.userId);
      const balanceOf = (id: string) => balances.find((r) => r.account_id === id)?.balance_cents;

      expect(balanceOf(nu1)).toBe(0); // nómina revertida
      expect(balanceOf(sueldo1)).toBe(0);
      expect(balanceOf(tdc2)).toBe(-70_000);
      expect(balanceOf(wifi2)).toBe(70_000);
      expect(balanceOf(nu3)).toBe(-70_000);
      expect(balanceOf(tdc3)).toBe(70_000);
      expect(balanceOf(nu45)).toBe(0);
      expect(balanceOf(porCobrar45)).toBe(0);
      expect(balanceOf(tdc6)).toBe(-80_000);
      expect(balanceOf(comida6)).toBe(40_000);
      expect(balanceOf(porCobrar6)).toBe(40_000);
      expect(balanceOf(nu7)).toBe(-50_000);
      expect(balanceOf(porCobrar7)).toBe(0); // préstamo incobrable saldado
      expect(balanceOf(perdidas7)).toBe(50_000);
      expect(balanceOf(nu8)).toBe(1_000_000);
      expect(balanceOf(tdc8)).toBe(-250_000);
      expect(balanceOf(efectivo8)).toBe(80_000);
      expect(balanceOf(saldoInicial8)).toBe(-830_000);
    });
  });

  it('T-G03: F1 de A con datos de B presentes → 0 filas de B', async () => {
    await withRollback(async (client) => {
      const { a, b } = await seedFixture(client);
      await spend(client, b.userId, b.accounts.nu, b.accounts.comida, 10_000, '2026-08-05');

      const balances = await accountBalances(client, a.userId);
      const bAccountIds = new Set(Object.values(b.accounts));
      expect(balances.some((r) => bAccountIds.has(r.account_id))).toBe(false);
    });
  });

  it('T-G04: asignar 100000, gastar 30000 → disponible=70000, has_budget=true', async () => {
    await withRollback(async (client) => {
      const { a } = await seedFixture(client);
      await insertBudgetEntry(client, { userId: a.userId, periodId: a.periods.p1, categoryId: a.accounts.comida, amountCents: 100_000 });
      await spend(client, a.userId, a.accounts.nu, a.accounts.comida, 30_000, '2026-08-05');

      const balance = await categoryBalance(client, a.userId, a.periods.p1, a.accounts.comida);
      expect(balance?.available_cents).toBe(70_000);
      expect(balance?.has_budget).toBe(true);
    });
  });

  it('T-G05: asignar 100000, gastar 120000 → disponible=-20000, has_budget=true', async () => {
    await withRollback(async (client) => {
      const { a } = await seedFixture(client);
      await insertBudgetEntry(client, { userId: a.userId, periodId: a.periods.p1, categoryId: a.accounts.comida, amountCents: 100_000 });
      await spend(client, a.userId, a.accounts.nu, a.accounts.comida, 120_000, '2026-08-05');

      const balance = await categoryBalance(client, a.userId, a.periods.p1, a.accounts.comida);
      expect(balance?.available_cents).toBe(-20_000);
      expect(balance?.has_budget).toBe(true);
    });
  });

  it('T-G06: gastar 30000 sin asignación → has_budget=false', async () => {
    await withRollback(async (client) => {
      const { a } = await seedFixture(client);
      await spend(client, a.userId, a.accounts.nu, a.accounts.comida, 30_000, '2026-08-05');

      const balance = await categoryBalance(client, a.userId, a.periods.p1, a.accounts.comida);
      expect(balance?.has_budget).toBe(false);
    });
  });

  it('T-G07: asignar 100000, gastar 100000 → disponible=0, has_budget=true (distinto de T-G06)', async () => {
    await withRollback(async (client) => {
      const { a } = await seedFixture(client);
      await insertBudgetEntry(client, { userId: a.userId, periodId: a.periods.p1, categoryId: a.accounts.comida, amountCents: 100_000 });
      await spend(client, a.userId, a.accounts.nu, a.accounts.comida, 100_000, '2026-08-05');

      const balance = await categoryBalance(client, a.userId, a.periods.p1, a.accounts.comida);
      expect(balance?.available_cents).toBe(0);
      expect(balance?.has_budget).toBe(true);
    });
  });

  it('T-G08: asignar 100000, borrar suave el budget_entry, gastar 30000 → has_budget=false, el asignado no cuenta', async () => {
    await withRollback(async (client) => {
      const { a } = await seedFixture(client);
      const id = await insertBudgetEntry(client, { userId: a.userId, periodId: a.periods.p1, categoryId: a.accounts.comida, amountCents: 100_000 });
      await client.query('UPDATE budget_entries SET deleted_at = now() WHERE id = $1', [id]);
      await spend(client, a.userId, a.accounts.nu, a.accounts.comida, 30_000, '2026-08-05');

      const balance = await categoryBalance(client, a.userId, a.periods.p1, a.accounts.comida);
      expect(balance?.has_budget).toBe(false);
    });
  });

  it('T-G09: P1 asigna/gasta; P2 rollover+manual → disponible de P2=170000 sin consultar P1', async () => {
    await withRollback(async (client) => {
      const { a } = await seedFixture(client);
      await insertBudgetEntry(client, { userId: a.userId, periodId: a.periods.p1, categoryId: a.accounts.comida, amountCents: 100_000 });
      await spend(client, a.userId, a.accounts.nu, a.accounts.comida, 30_000, '2026-08-05');

      await insertBudgetEntry(client, {
        userId: a.userId,
        periodId: a.periods.p2,
        categoryId: a.accounts.comida,
        amountCents: 70_000,
        source: 'rollover',
        note: 'rollover desde P1',
      });
      await insertBudgetEntry(client, { userId: a.userId, periodId: a.periods.p2, categoryId: a.accounts.comida, amountCents: 100_000 });

      const p2Balance = await categoryBalance(client, a.userId, a.periods.p2, a.accounts.comida);
      expect(p2Balance?.assigned_cents).toBe(170_000);
      expect(p2Balance?.available_cents).toBe(170_000);
    });
  });

  it('T-G10: gasto con booked_at fuera del rango del periodo no se cuenta en ese periodo', async () => {
    await withRollback(async (client) => {
      const { a } = await seedFixture(client);
      await insertBudgetEntry(client, { userId: a.userId, periodId: a.periods.p1, categoryId: a.accounts.comida, amountCents: 100_000 });
      // Fuera de p1 [08-01,08-15] y de p2 [08-16,08-31]: cae después de ambos.
      await spend(client, a.userId, a.accounts.nu, a.accounts.comida, 30_000, '2026-09-05');

      const balance = await categoryBalance(client, a.userId, a.periods.p1, a.accounts.comida);
      expect(balance?.spent_cents).toBe(0);
      expect(balance?.available_cents).toBe(100_000);
    });
  });

  it('T-G11: Nu +100000, sin asignaciones, un periodo abierto → sin_asignar=100000', async () => {
    await withRollback(async (client) => {
      const { a } = await seedFixture(client);
      await insertBalancedTransaction(client, {
        userId: a.userId,
        bookedAt: '2026-08-05',
        entries: [
          { accountId: a.accounts.nu, amountCents: 100_000 },
          { accountId: a.accounts.sueldo, amountCents: -100_000 },
        ],
      });

      expect(await unassignedFunds(client, a.userId)).toBe(100_000);
    });
  });

  it('T-G12: Nu +100000, TDC -25000 → sin_asignar=75000', async () => {
    await withRollback(async (client) => {
      const { a } = await seedFixture(client);
      await insertBalancedTransaction(client, {
        userId: a.userId,
        bookedAt: '2026-08-05',
        entries: [
          { accountId: a.accounts.nu, amountCents: 100_000 },
          { accountId: a.accounts.sueldo, amountCents: -100_000 },
        ],
      });
      await spend(client, a.userId, a.accounts.tdc, a.accounts.comida, 25_000, '2026-08-05');
      // La deuda de TDC debe restar sin importar dónde quedó el gasto asociado.
      await insertBudgetEntry(client, { userId: a.userId, periodId: a.periods.p1, categoryId: a.accounts.comida, amountCents: 25_000 });

      expect(await unassignedFunds(client, a.userId)).toBe(75_000);
    });
  });

  it('T-G13: Nu +100000, PorCobrar +50000 → sin_asignar=100000, no 150000 (F3 excluye receivable)', async () => {
    await withRollback(async (client) => {
      const { a } = await seedFixture(client);
      await insertBalancedTransaction(client, {
        userId: a.userId,
        bookedAt: '2026-08-05',
        entries: [
          { accountId: a.accounts.nu, amountCents: 100_000 },
          { accountId: a.accounts.sueldo, amountCents: -100_000 },
        ],
      });
      // PorCobrar se fondea contra `equity` (excluida de dinero_real, §3.9),
      // no contra Nu: así Nu queda en +100000 y PorCobrar en +50000 de
      // forma independiente, tal como lo describe TASK-db.md.
      await insertBalancedTransaction(client, {
        userId: a.userId,
        bookedAt: '2026-08-05',
        entries: [
          { accountId: a.accounts.saldoInicial, amountCents: -50_000 },
          { accountId: a.accounts.porCobrarFer, amountCents: 50_000 },
        ],
      });

      expect(await unassignedFunds(client, a.userId)).toBe(100_000);
    });
  });

  it('T-G14 ⚠️: ejemplo canónico #1 → sin_asignar=740000', async () => {
    await withRollback(async (client) => {
      const { a } = await seedFixture(client);
      await insertBalancedTransaction(client, {
        userId: a.userId,
        bookedAt: '2026-08-05',
        entries: [
          { accountId: a.accounts.nu, amountCents: 1_000_000 },
          { accountId: a.accounts.sueldo, amountCents: -1_000_000 },
        ],
      });
      await insertBudgetEntry(client, { userId: a.userId, periodId: a.periods.p1, categoryId: a.accounts.comida, amountCents: 200_000 });
      await spend(client, a.userId, a.accounts.nu, a.accounts.comida, 50_000, '2026-08-05');
      await spend(client, a.userId, a.accounts.nu, a.accounts.salud, 30_000, '2026-08-06');

      expect(await unassignedFunds(client, a.userId)).toBe(740_000);
    });
  });

  it('T-G15 ⚠️: contraprueba de la resta global — el valor de control (800000) NO debe ser el resultado', async () => {
    await withRollback(async (client) => {
      const { a } = await seedFixture(client);
      await insertBalancedTransaction(client, {
        userId: a.userId,
        bookedAt: '2026-08-05',
        entries: [
          { accountId: a.accounts.nu, amountCents: 1_000_000 },
          { accountId: a.accounts.sueldo, amountCents: -1_000_000 },
        ],
      });
      await insertBudgetEntry(client, { userId: a.userId, periodId: a.periods.p1, categoryId: a.accounts.comida, amountCents: 200_000 });
      await spend(client, a.userId, a.accounts.nu, a.accounts.comida, 50_000, '2026-08-05');
      await spend(client, a.userId, a.accounts.nu, a.accounts.salud, 30_000, '2026-08-06');

      const result = await unassignedFunds(client, a.userId);
      expect(result).not.toBe(800_000);
      expect(result).toBe(740_000);
    });
  });

  it('T-G16 ⚠️: ejemplo canónico #2, dos periodos abiertos → sin_asignar=1140000', async () => {
    await withRollback(async (client) => {
      const { a } = await seedFixture(client);
      await insertBalancedTransaction(client, {
        userId: a.userId,
        bookedAt: '2026-08-05',
        entries: [
          { accountId: a.accounts.nu, amountCents: 1_000_000 },
          { accountId: a.accounts.sueldo, amountCents: -1_000_000 },
        ],
      });
      await insertBudgetEntry(client, { userId: a.userId, periodId: a.periods.p1, categoryId: a.accounts.comida, amountCents: 200_000 });
      await spend(client, a.userId, a.accounts.nu, a.accounts.comida, 50_000, '2026-08-05');
      await spend(client, a.userId, a.accounts.nu, a.accounts.salud, 30_000, '2026-08-06');

      // Ingreso adicional + un tercer periodo abierto (P1 y P2 ya están
      // abiertos por el fixture; se usa P2 como el "nuevo" periodo sin cerrar P1).
      await insertBalancedTransaction(client, {
        userId: a.userId,
        bookedAt: '2026-08-20',
        entries: [
          { accountId: a.accounts.nu, amountCents: 500_000 },
          { accountId: a.accounts.sueldo, amountCents: -500_000 },
        ],
      });
      await insertBudgetEntry(client, { userId: a.userId, periodId: a.periods.p2, categoryId: a.accounts.comida, amountCents: 100_000 });

      expect(await unassignedFunds(client, a.userId)).toBe(1_140_000);
    });
  });

  it('T-G17 ⚠️: periodos cerrados excluidos — el rollover se cuenta una sola vez', async () => {
    await withRollback(async (client) => {
      const { a } = await seedFixture(client);
      await insertBalancedTransaction(client, {
        userId: a.userId,
        bookedAt: '2026-08-01',
        entries: [
          { accountId: a.accounts.nu, amountCents: 1_000_000 },
          { accountId: a.accounts.sueldo, amountCents: -1_000_000 },
        ],
      });
      await insertBudgetEntry(client, { userId: a.userId, periodId: a.periods.p1, categoryId: a.accounts.servicios, amountCents: 200_000 });
      await spend(client, a.userId, a.accounts.nu, a.accounts.servicios, 50_000, '2026-08-05');
      // disponible P1 Servicios = 150000, accumulate.

      const before = await unassignedFunds(client, a.userId);

      await insertBudgetEntry(client, {
        userId: a.userId,
        periodId: a.periods.p2,
        categoryId: a.accounts.servicios,
        amountCents: 150_000,
        source: 'rollover',
        note: 'rollover Servicios desde P1',
      });
      await client.query('UPDATE budget_periods SET closed_at = now() WHERE id = $1', [a.periods.p1]);

      const after = await unassignedFunds(client, a.userId);
      expect(after).toBe(before);
    });
  });

  it('T-G18: registrar ingreso +500000 sube sin_asignar exactamente 500000', async () => {
    await withRollback(async (client) => {
      const { a } = await seedFixture(client);
      const before = await unassignedFunds(client, a.userId);

      await insertBalancedTransaction(client, {
        userId: a.userId,
        bookedAt: '2026-08-05',
        entries: [
          { accountId: a.accounts.nu, amountCents: 500_000 },
          { accountId: a.accounts.sueldo, amountCents: -500_000 },
        ],
      });

      const after = await unassignedFunds(client, a.userId);
      expect(after - before).toBe(500_000);
    });
  });

  it('T-G19: F4 — tx en un hueco entre periodos aparece; tx dentro de un periodo no', async () => {
    await withRollback(async (client) => {
      const { a } = await seedFixture(client);
      const p3 = randomUUID();
      // Hueco deliberado entre p2 (termina 08-31) y p3 (empieza 09-10).
      await insertPeriod(client, { id: p3, userId: a.userId, startsOn: '2026-09-10', endsOn: '2026-09-20' });

      const inGap = await insertBalancedTransaction(client, {
        userId: a.userId,
        bookedAt: '2026-09-03',
        entries: [
          { accountId: a.accounts.nu, amountCents: -10_000 },
          { accountId: a.accounts.comida, amountCents: 10_000 },
        ],
      });
      const inPeriod = await insertBalancedTransaction(client, {
        userId: a.userId,
        bookedAt: '2026-08-05',
        entries: [
          { accountId: a.accounts.nu, amountCents: -10_000 },
          { accountId: a.accounts.comida, amountCents: 10_000 },
        ],
      });

      const pending = await transactionsWithoutPeriod(client, a.userId);
      expect(pending).toContain(inGap.transactionId);
      expect(pending).not.toContain(inPeriod.transactionId);
    });
  });

  it('T-G20 ⚠️: archivar no mueve dinero (F1) — los saldos son idénticos antes/después', async () => {
    await withRollback(async (client) => {
      const { a } = await seedFixture(client);
      await spend(client, a.userId, a.accounts.nu, a.accounts.comida, 30_000, '2026-08-05');

      const before = await accountBalances(client, a.userId);
      await client.query('UPDATE accounts SET archived_at = now() WHERE id = $1', [a.accounts.comida]);
      const after = await accountBalances(client, a.userId);

      expect(after).toEqual(before);
      expect(after.some((r) => r.account_id === a.accounts.comida)).toBe(true);
    });
  });

  it('T-G21 ⚠️: archivar no mueve dinero (F3) — el valor es idéntico', async () => {
    await withRollback(async (client) => {
      const { a } = await seedFixture(client);
      await insertBudgetEntry(client, { userId: a.userId, periodId: a.periods.p1, categoryId: a.accounts.comida, amountCents: 100_000 });
      await spend(client, a.userId, a.accounts.nu, a.accounts.comida, 40_000, '2026-08-05');

      const before = await unassignedFunds(client, a.userId);
      await client.query('UPDATE accounts SET archived_at = now() WHERE id = $1', [a.accounts.comida]);
      const after = await unassignedFunds(client, a.userId);

      expect(after).toBe(before);
    });
  });

  it('T-G22: invocar F1-F4 sin p_user_id falla las cuatro (42883, función no existe con esa aridad)', async () => {
    await withRollback(async (client) => {
      await seedFixture(client);
      // Cada llamada fallida aborta la transacción — sin SAVEPOINT, la
      // segunda en adelante recibe 25P02 (transacción abortada) en vez de
      // su propio 42883, porque Postgres ya descartó todo lo posterior
      // al primer error. Mismo mecanismo que documenta T-H04.
      for (const sql of [
        'SELECT * FROM fn_account_balances()',
        'SELECT * FROM fn_category_balances()',
        'SELECT * FROM fn_unassigned_funds()',
        'SELECT * FROM fn_transactions_without_period()',
      ]) {
        await client.query('SAVEPOINT t_g22');
        await expect(client.query(sql)).rejects.toMatchObject({ code: '42883' });
        await client.query('ROLLBACK TO SAVEPOINT t_g22');
      }
    });
  });

  it('T-G23: fn_unassigned_funds con dos argumentos falla (firma de un solo parámetro)', async () => {
    await withRollback(async (client) => {
      const { a } = await seedFixture(client);
      await expect(
        client.query('SELECT * FROM fn_unassigned_funds($1, $2)', [a.userId, a.userId]),
      ).rejects.toMatchObject({ code: '42883' });
    });
  });
});
