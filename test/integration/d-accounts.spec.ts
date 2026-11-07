import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { closePool, withRollback } from '../setup/db';
import { expectImmediateRejection } from '../setup/expect-errcode';
import { seedFixture, insertAccount } from '../setup/fixture';
import { insertTransaction, insertEntry } from '../setup/ledger';

/**
 * R8 (archivar con saldo cero) es inmediato: `BEFORE UPDATE ON accounts`
 * cuando `archived_at` pasa de NULL a no-NULL. Como estos tests corren
 * dentro de `withRollback` (sin COMMIT), el saldo se arma con un solo
 * entry sin contraparte — R1/R2 (suma-cero) son diferidos y nunca se
 * disparan porque la transacción nunca llega a COMMIT.
 */
describe('Grupo D — cuentas: CHECKs, unicidad case-insensitive, R8 (U03, U14)', () => {
  afterAll(async () => {
    await closePool();
  });

  async function setBalance(
    client: PoolClient,
    userId: string,
    accountId: string,
    amountCents: number,
  ): Promise<void> {
    const transactionId = await insertTransaction(client, { userId, bookedAt: '2026-08-05' });
    await insertEntry(client, { transactionId, userId, accountId, amountCents });
  }

  it('T-D01: type=expense, rollover_type=NULL → ❌ 23514', async () => {
    await withRollback(async (client) => {
      const { a } = await seedFixture(client);
      await expectImmediateRejection(
        client,
        () =>
          insertAccount(client, {
            id: randomUUID(),
            userId: a.userId,
            name: 'Otra categoría',
            type: 'expense',
            rolloverType: null,
          }),
        '23514',
        'accounts',
      );
    });
  });

  it('T-D02: type=asset, rollover_type=reset → ❌ 23514', async () => {
    await withRollback(async (client) => {
      const { a } = await seedFixture(client);
      await expectImmediateRejection(
        client,
        () =>
          insertAccount(client, {
            id: randomUUID(),
            userId: a.userId,
            name: 'Otro asset',
            type: 'asset',
            rolloverType: 'reset',
          }),
        '23514',
        'accounts',
      );
    });
  });

  it('T-D03: type=receivable, rollover_type=accumulate → ❌ 23514', async () => {
    await withRollback(async (client) => {
      const { a } = await seedFixture(client);
      await expectImmediateRejection(
        client,
        () =>
          insertAccount(client, {
            id: randomUUID(),
            userId: a.userId,
            name: 'Otro préstamo',
            type: 'receivable',
            rolloverType: 'accumulate',
          }),
        '23514',
        'accounts',
      );
    });
  });

  it('T-D04: type=asset, is_system=true → ❌ 23514', async () => {
    await withRollback(async (client) => {
      const { a } = await seedFixture(client);
      await expectImmediateRejection(
        client,
        () =>
          insertAccount(client, {
            id: randomUUID(),
            userId: a.userId,
            name: 'Asset de sistema',
            type: 'asset',
            isSystem: true,
          }),
        '23514',
        'accounts',
      );
    });
  });

  it('T-D05: dos cuentas activas del mismo usuario "Nu" y "nu" → ❌ 23505 (índice usa lower(name))', async () => {
    await withRollback(async (client) => {
      const { a } = await seedFixture(client);
      await expectImmediateRejection(
        client,
        () =>
          insertAccount(client, { id: randomUUID(), userId: a.userId, name: 'nu', type: 'asset' }),
        '23505',
        'accounts',
      );
    });
  });

  it('T-D06: "Nu" activa + "Nu" archivada → ✅', async () => {
    await withRollback(async (client) => {
      const { a } = await seedFixture(client);
      await insertAccount(client, {
        id: randomUUID(),
        userId: a.userId,
        name: 'Nu',
        type: 'asset',
        archivedAt: '2026-01-01T00:00:00Z',
      });
      const { rows } = await client.query(
        `SELECT count(*)::int AS n FROM accounts WHERE user_id = $1 AND lower(name) = 'nu'`,
        [a.userId],
      );
      expect(rows[0].n).toBe(2);
    });
  });

  it('T-D07: "Nu" para A y "Nu" para B → ✅', async () => {
    await withRollback(async (client) => {
      const { a, b } = await seedFixture(client);
      expect(a.accounts.nu).not.toBe(b.accounts.nu);
      // Acotado a los dos IDs del fixture, no un conteo global: la suite
      // completa corre otros archivos que dejan "Nu" comprometidas antes
      // de este (a-balance-zero, c-immutability-reversal, h-idempotency
      // truncan y re-siembran vía commits reales en su propio beforeEach),
      // así que un conteo global de lower(name)='nu' ve ese residuo y no
      // solo lo que crea este test.
      const { rows } = await client.query(
        `SELECT count(*)::int AS n FROM accounts WHERE id = ANY($1::uuid[]) AND lower(name) = 'nu'`,
        [[a.accounts.nu, b.accounts.nu]],
      );
      expect(rows[0].n).toBe(2);
    });
  });

  it.each(['mxn', 'MX'])('T-D08: currency=%s → ❌ 23514', async (currency) => {
    await withRollback(async (client) => {
      const { a } = await seedFixture(client);
      await expectImmediateRejection(
        client,
        () =>
          insertAccount(client, {
            id: randomUUID(),
            userId: a.userId,
            name: `Cuenta ${currency}`,
            type: 'asset',
            currency,
          }),
        '23514',
        'accounts',
      );
    });
  });

  // ARCHITECTURE.md §3.3 declara `currency char(3)` explícitamente — con
  // ese tipo, Postgres rechaza un valor de 4 caracteres con 22001 antes
  // de que accounts_currency_format (23514) llegue a evaluarse. mxn/MX sí
  // caben en char(3) y llegan al CHECK; MXNN no. ARCHITECTURE.md es la
  // fuente de verdad ante cualquier ambigüedad (TASK-db.md, encabezado) —
  // confirmado con Luis, no una decisión tomada por criterio propio.
  it('T-D08: currency=MXNN (excede char(3)) → ❌ 22001', async () => {
    await withRollback(async (client) => {
      const { a } = await seedFixture(client);
      await expectImmediateRejection(
        client,
        () =>
          insertAccount(client, {
            id: randomUUID(),
            userId: a.userId,
            name: 'Cuenta MXNN',
            type: 'asset',
            currency: 'MXNN',
          }),
        '22001',
        'accounts',
      );
    });
  });

  it('T-D09: archivar asset con saldo +50000 → ❌ P1008, archived_at sigue NULL', async () => {
    await withRollback(async (client) => {
      const { a } = await seedFixture(client);
      await setBalance(client, a.userId, a.accounts.nu, 50000);

      await expectImmediateRejection(
        client,
        () => client.query('UPDATE accounts SET archived_at = now() WHERE id = $1', [a.accounts.nu]),
        'P1008',
        'accounts',
      );

      const { rows } = await client.query('SELECT archived_at FROM accounts WHERE id = $1', [a.accounts.nu]);
      expect(rows[0].archived_at).toBeNull();
    });
  });

  it('T-D10: archivar receivable con saldo +40000 → ❌ P1008', async () => {
    await withRollback(async (client) => {
      const { a } = await seedFixture(client);
      await setBalance(client, a.userId, a.accounts.porCobrarFer, 40000);

      await expectImmediateRejection(
        client,
        () => client.query('UPDATE accounts SET archived_at = now() WHERE id = $1', [a.accounts.porCobrarFer]),
        'P1008',
        'accounts',
      );
    });
  });

  it('T-D11: archivar liability con saldo -25000 → ❌ P1008', async () => {
    await withRollback(async (client) => {
      const { a } = await seedFixture(client);
      await setBalance(client, a.userId, a.accounts.tdc, -25000);

      await expectImmediateRejection(
        client,
        () => client.query('UPDATE accounts SET archived_at = now() WHERE id = $1', [a.accounts.tdc]),
        'P1008',
        'accounts',
      );
    });
  });

  it('T-D12: archivar expense "Comida" con saldo acumulado +50000 → ✅ éxito (discriminante de U14)', async () => {
    await withRollback(async (client) => {
      const { a } = await seedFixture(client);
      await setBalance(client, a.userId, a.accounts.comida, 50000);

      await client.query('UPDATE accounts SET archived_at = now() WHERE id = $1', [a.accounts.comida]);

      const { rows } = await client.query('SELECT archived_at FROM accounts WHERE id = $1', [a.accounts.comida]);
      expect(rows[0].archived_at).not.toBeNull();
    });
  });

  it('T-D13: archivar income "Sueldo" con saldo -1000000 → ✅ éxito', async () => {
    await withRollback(async (client) => {
      const { a } = await seedFixture(client);
      await setBalance(client, a.userId, a.accounts.sueldo, -1000000);

      await client.query('UPDATE accounts SET archived_at = now() WHERE id = $1', [a.accounts.sueldo]);

      const { rows } = await client.query('SELECT archived_at FROM accounts WHERE id = $1', [a.accounts.sueldo]);
      expect(rows[0].archived_at).not.toBeNull();
    });
  });

  it('T-D14: DELETE FROM accounts de una cuenta con entries → ❌ 23503', async () => {
    await withRollback(async (client) => {
      const { a } = await seedFixture(client);
      await setBalance(client, a.userId, a.accounts.nu, 10000);

      await expectImmediateRejection(
        client,
        () => client.query('DELETE FROM accounts WHERE id = $1', [a.accounts.nu]),
        '23503',
        'accounts',
      );
    });
  });

  it('T-D15: archivar asset con saldo 0 → ✅ éxito', async () => {
    await withRollback(async (client) => {
      const { a } = await seedFixture(client);
      // Nu no tiene entries: saldo 0 por definición (LEFT JOIN en F1).
      await client.query('UPDATE accounts SET archived_at = now() WHERE id = $1', [a.accounts.nu]);

      const { rows } = await client.query('SELECT archived_at FROM accounts WHERE id = $1', [a.accounts.nu]);
      expect(rows[0].archived_at).not.toBeNull();
    });
  });
});
