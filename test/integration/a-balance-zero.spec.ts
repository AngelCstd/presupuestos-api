import { pool, closePool, withRollback, countRows } from '../setup/db';
import { truncateAll, withCommit, beginTx, commitTx, expectDeferredRejection } from '../setup/commit-helper';
import { expectImmediateRejection } from '../setup/expect-errcode';
import { seedFixture, insertAccount, type Fixture } from '../setup/fixture';
import { insertTransaction, insertEntry, insertBalancedTransaction } from '../setup/ledger';
import { randomUUID } from 'node:crypto';

/**
 * Grupo A necesita COMMITs reales (R1/R2/R4 son diferidos, TASK-db.md §5.1):
 * el error solo aparece al cerrar la transacción, así que probar el éxito
 * también requiere llegar al COMMIT. Eso deja datos permanentes (entries/
 * transactions son inmutables, no se pueden borrar), así que cada test
 * arranca de una base truncada y con el fixture recién sembrado.
 *
 * "Wifi" de los ejemplos de TASK-db.md no está en el fixture U22; se usa
 * `Comida` como categoría de gasto genérica — el tipo de cuenta es lo
 * único que importa para estas reglas.
 *
 * T-A07 y T-A09 son la excepción dentro de este archivo: prueban
 * `entries_amount_nonzero` (CHECK) y R5, ambos INMEDIATOS — no forman
 * parte del disparo diferido de R1/R2/R4/R9. Por eso usan `withRollback`
 * en vez de `withCommit`/`expectDeferredRejection`, igual que R5/R6 en
 * c-immutability-reversal.spec.ts. Viven en este archivo (no en Grupo C)
 * porque TASK-db.md los agrupa aquí (§5.2, Grupo A).
 */
describe('Grupo A — suma cero (R1, R2, R4) y timing diferido (U09)', () => {
  let fixture: Fixture;

  beforeEach(async () => {
    const client = await pool.connect();
    try {
      await truncateAll(client);
      fixture = await seedFixture(client);
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    await closePool();
  });

  async function balancesOf(userId: string): Promise<Map<string, number>> {
    const { rows } = await pool.query(
      'SELECT account_id, balance_cents FROM fn_account_balances($1)',
      [userId],
    );
    return new Map(rows.map((r: { account_id: string; balance_cents: number }) => [r.account_id, r.balance_cents]));
  }

  it('T-A01: tx + entries [Nu -70000, Comida +70000], COMMIT → balanceada, cuenta y comprometida', async () => {
    const a = fixture.a;
    await withCommit(async (client) => {
      const { transactionId, entryIds } = await insertBalancedTransaction(client, {
        userId: a.userId,
        bookedAt: '2026-08-05',
        entries: [
          { accountId: a.accounts.nu, amountCents: -70000 },
          { accountId: a.accounts.comida, amountCents: 70000 },
        ],
      });
      expect(transactionId).toBeTruthy();
      expect(entryIds).toHaveLength(2);
    });

    expect(await countRows(pool, 'transactions')).toBe(1);
    expect(await countRows(pool, 'entries')).toBe(2);

    const balances = await balancesOf(a.userId);
    expect(balances.get(a.accounts.nu)).toBe(-70000);
    expect(balances.get(a.accounts.comida)).toBe(70000);
  });

  it('T-A02: entries [TDC -80000, Comida +40000, PorCobrar +40000] → los tres saldos cambian exactamente', async () => {
    const a = fixture.a;
    await withCommit(async (client) => {
      await insertBalancedTransaction(client, {
        userId: a.userId,
        bookedAt: '2026-08-05',
        entries: [
          { accountId: a.accounts.tdc, amountCents: -80000 },
          { accountId: a.accounts.comida, amountCents: 40000 },
          { accountId: a.accounts.porCobrarFer, amountCents: 40000 },
        ],
      });
    });

    expect(await countRows(pool, 'entries')).toBe(3);
    const balances = await balancesOf(a.userId);
    expect(balances.get(a.accounts.tdc)).toBe(-80000);
    expect(balances.get(a.accounts.comida)).toBe(40000);
    expect(balances.get(a.accounts.porCobrarFer)).toBe(40000);
  });

  it('T-A03: entries [+70000, -60000] → ❌ P1001 en el COMMIT, nada queda escrito', async () => {
    const a = fixture.a;
    const beforeTx = await countRows(pool, 'transactions');
    const beforeEntries = await countRows(pool, 'entries');

    await expectDeferredRejection(async (client) => {
      await insertBalancedTransaction(client, {
        userId: a.userId,
        bookedAt: '2026-08-05',
        entries: [
          { accountId: a.accounts.nu, amountCents: 70000 },
          { accountId: a.accounts.comida, amountCents: -60000 },
        ],
      });
    }, 'P1001');

    expect(await countRows(pool, 'transactions')).toBe(beforeTx);
    expect(await countRows(pool, 'entries')).toBe(beforeEntries);
  });

  it('T-A04: entries [+60000, -70000] → ❌ P1001 en el COMMIT (mismo caso, signos invertidos)', async () => {
    const a = fixture.a;
    const beforeTx = await countRows(pool, 'transactions');
    const beforeEntries = await countRows(pool, 'entries');

    await expectDeferredRejection(async (client) => {
      await insertBalancedTransaction(client, {
        userId: a.userId,
        bookedAt: '2026-08-05',
        entries: [
          { accountId: a.accounts.nu, amountCents: 60000 },
          { accountId: a.accounts.comida, amountCents: -70000 },
        ],
      });
    }, 'P1001');

    expect(await countRows(pool, 'transactions')).toBe(beforeTx);
    expect(await countRows(pool, 'entries')).toBe(beforeEntries);
  });

  it('T-A05: tx sin ningún entry, COMMIT → éxito (R1 trata SUM NULL como aprobado)', async () => {
    const a = fixture.a;
    let transactionId = '';
    await withCommit(async (client) => {
      transactionId = await insertTransaction(client, { userId: a.userId, bookedAt: '2026-08-05' });
    });

    const { rows } = await pool.query('SELECT id FROM transactions WHERE id = $1', [transactionId]);
    expect(rows).toHaveLength(1);
    expect(await countRows(pool, 'entries')).toBe(0);
  });

  it('T-A06: un solo entry [+70000] → ❌ P1002 en el COMMIT, no P1001', async () => {
    const a = fixture.a;
    const beforeTx = await countRows(pool, 'transactions');
    const beforeEntries = await countRows(pool, 'entries');

    await expectDeferredRejection(async (client) => {
      const transactionId = await insertTransaction(client, { userId: a.userId, bookedAt: '2026-08-05' });
      await insertEntry(client, {
        transactionId,
        userId: a.userId,
        accountId: a.accounts.nu,
        amountCents: 70000,
      });
    }, 'P1002');

    expect(await countRows(pool, 'transactions')).toBe(beforeTx);
    expect(await countRows(pool, 'entries')).toBe(beforeEntries);
  });

  it('T-A07: entry con amount_cents = 0 → ❌ 23514 (CHECK, inmediato)', async () => {
    const a = fixture.a;
    // CHECK (entries_amount_nonzero), inmediato — no es R1/R2/R4. withRollback alcanza.
    await withRollback(async (client) => {
      const transactionId = await insertTransaction(client, { userId: a.userId, bookedAt: '2026-08-05' });
      await expectImmediateRejection(
        client,
        () =>
          insertEntry(client, {
            transactionId,
            userId: a.userId,
            accountId: a.accounts.nu,
            amountCents: 0,
          }),
        '23514',
        'entries',
      );
    });
  });

  it('T-A08: insertar solo [+70000] sin COMMIT no lanza; balancear después y el COMMIT pasa (discriminante del diferimiento)', async () => {
    const a = fixture.a;
    const client = await beginTx();
    try {
      const transactionId = await insertTransaction(client, { userId: a.userId, bookedAt: '2026-08-05' });
      await expect(
        insertEntry(client, {
          transactionId,
          userId: a.userId,
          accountId: a.accounts.nu,
          amountCents: 70000,
        }),
      ).resolves.toBeTruthy();

      await insertEntry(client, {
        transactionId,
        userId: a.userId,
        accountId: a.accounts.comida,
        amountCents: -70000,
      });
    } finally {
      await commitTx(client);
    }

    expect(await countRows(pool, 'entries')).toBe(2);
  });

  it('T-A09: DELETE de un entry de una tx válida → ❌ P1005 en el statement, el entry sigue existiendo', async () => {
    const a = fixture.a;
    // R5, inmediato (BEFORE UPDATE OR DELETE) — no es el trigger diferido
    // de R1/R2/R4. withRollback alcanza, igual que en Grupo C.
    await withRollback(async (client) => {
      const { entryIds } = await insertBalancedTransaction(client, {
        userId: a.userId,
        bookedAt: '2026-08-05',
        entries: [
          { accountId: a.accounts.nu, amountCents: -70000 },
          { accountId: a.accounts.comida, amountCents: 70000 },
        ],
      });

      await expectImmediateRejection(
        client,
        () => client.query('DELETE FROM entries WHERE id = $1', [entryIds[0]]),
        'P1005',
        'entries',
      );
    });
  });

  it('T-A10: cuenta MXN + cuenta USD en la misma tx → ❌ P1004 en el COMMIT', async () => {
    const a = fixture.a;
    const beforeTx = await countRows(pool, 'transactions');

    await expectDeferredRejection(async (client) => {
      const usdAccountId = randomUUID();
      await insertAccount(client, {
        id: usdAccountId,
        userId: a.userId,
        name: 'Cuenta USD',
        type: 'asset',
        currency: 'USD',
      });
      await insertBalancedTransaction(client, {
        userId: a.userId,
        bookedAt: '2026-08-05',
        entries: [
          { accountId: a.accounts.nu, amountCents: -70000 },
          { accountId: usdAccountId, amountCents: 70000 },
        ],
      });
    }, 'P1004');

    expect(await countRows(pool, 'transactions')).toBe(beforeTx);
  });
});
