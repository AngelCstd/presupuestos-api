import { pool, closePool, withRollback, countRows } from '../setup/db';
import { truncateAll, withCommit, expectDeferredRejection } from '../setup/commit-helper';
import { expectImmediateRejection } from '../setup/expect-errcode';
import { seedFixture, insertAccount, type Fixture } from '../setup/fixture';
import { insertTransaction, insertEntry, insertBalancedTransaction } from '../setup/ledger';
import { randomUUID } from 'node:crypto';

/**
 * R5/R6 son inmediatos (withRollback alcanza). R9 tiene dos disparos
 * diferidos (§3.4): uno sobre `entries` (misma función que R1) y otro
 * sobre `transactions`, solo cuando `reverses_transaction_id IS NOT NULL`
 * — TASK-db.md §5.1 exige llegar al COMMIT para probarlos. Como algunos
 * tests de este archivo comprometen datos reales (T-C07, T-C08, y las
 * configuraciones de T-C09/C10/C11), cada test arranca de una base
 * truncada con el fixture recién sembrado.
 */
describe('Grupo C — inmutabilidad (R5, R6) y magnitud de reversa (R9, U11/U12)', () => {
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

  it('T-C01: UPDATE entries SET amount_cents = 99999 → ❌ P1005, el valor original sigue', async () => {
    await withRollback(async (client) => {
      const fx = await seedFixture(client);
      const { entryIds } = await insertBalancedTransaction(client, {
        userId: fx.a.userId,
        bookedAt: '2026-08-05',
        entries: [
          { accountId: fx.a.accounts.nu, amountCents: -70000 },
          { accountId: fx.a.accounts.comida, amountCents: 70000 },
        ],
      });

      await expectImmediateRejection(
        client,
        () => client.query('UPDATE entries SET amount_cents = 99999 WHERE id = $1', [entryIds[0]]),
        'P1005',
        'entries',
      );

      const { rows } = await client.query('SELECT amount_cents FROM entries WHERE id = $1', [entryIds[0]]);
      expect(rows[0].amount_cents).toBe(-70000);
    });
  });

  it('T-C02: DELETE FROM entries WHERE id=<existente> → ❌ P1005, la fila sigue', async () => {
    await withRollback(async (client) => {
      const fx = await seedFixture(client);
      const { entryIds } = await insertBalancedTransaction(client, {
        userId: fx.a.userId,
        bookedAt: '2026-08-05',
        entries: [
          { accountId: fx.a.accounts.nu, amountCents: -70000 },
          { accountId: fx.a.accounts.comida, amountCents: 70000 },
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

  it('T-C03: UPDATE transactions SET booked_at=... → ❌ P1006, sin cambio', async () => {
    await withRollback(async (client) => {
      const fx = await seedFixture(client);
      const transactionId = await insertTransaction(client, {
        userId: fx.a.userId,
        bookedAt: '2026-08-05',
      });

      await expectImmediateRejection(
        client,
        () => client.query('UPDATE transactions SET booked_at = $1 WHERE id = $2', ['2020-01-01', transactionId]),
        'P1006',
        'transactions',
      );

      const { rows } = await client.query('SELECT booked_at FROM transactions WHERE id = $1', [transactionId]);
      expect(rows[0].booked_at.toISOString().slice(0, 10)).toBe('2026-08-05');
    });
  });

  it('T-C04: UPDATE transactions SET reverses_transaction_id=<otra> → ❌ P1006, sin cambio', async () => {
    await withRollback(async (client) => {
      const fx = await seedFixture(client);
      const tx1 = await insertTransaction(client, { userId: fx.a.userId, bookedAt: '2026-08-05' });
      const tx2 = await insertTransaction(client, { userId: fx.a.userId, bookedAt: '2026-08-06' });

      await expectImmediateRejection(
        client,
        () => client.query('UPDATE transactions SET reverses_transaction_id = $1 WHERE id = $2', [tx1, tx2]),
        'P1006',
        'transactions',
      );

      const { rows } = await client.query('SELECT reverses_transaction_id FROM transactions WHERE id = $1', [tx2]);
      expect(rows[0].reverses_transaction_id).toBeNull();
    });
  });

  it('T-C05: DELETE FROM transactions WHERE id=<existente> → ❌ P1006, la fila sigue', async () => {
    await withRollback(async (client) => {
      const fx = await seedFixture(client);
      const transactionId = await insertTransaction(client, { userId: fx.a.userId, bookedAt: '2026-08-05' });

      await expectImmediateRejection(
        client,
        () => client.query('DELETE FROM transactions WHERE id = $1', [transactionId]),
        'P1006',
        'transactions',
      );
    });
  });

  it('T-C06: UPDATE transactions SET description=... → ✅ el texto cambió', async () => {
    await withRollback(async (client) => {
      const fx = await seedFixture(client);
      const transactionId = await insertTransaction(client, {
        userId: fx.a.userId,
        bookedAt: '2026-08-05',
        description: 'original',
      });

      await client.query('UPDATE transactions SET description = $1 WHERE id = $2', ['corregido', transactionId]);

      const { rows } = await client.query('SELECT description FROM transactions WHERE id = $1', [transactionId]);
      expect(rows[0].description).toBe('corregido');
    });
  });

  it('T-C07: T2 reversa exacta de T1 → ✅ fn_account_balances vuelve al estado previo, ambas tx existen', async () => {
    const a = fixture.a;
    let t1 = '';
    await withCommit(async (client) => {
      t1 = (
        await insertBalancedTransaction(client, {
          userId: a.userId,
          bookedAt: '2026-08-05',
          entries: [
            { accountId: a.accounts.nu, amountCents: -70000 },
            { accountId: a.accounts.comida, amountCents: 70000 },
          ],
        })
      ).transactionId;
    });

    let t2 = '';
    await withCommit(async (client) => {
      t2 = (
        await insertBalancedTransaction(client, {
          userId: a.userId,
          bookedAt: '2026-08-06',
          reversesTransactionId: t1,
          entries: [
            { accountId: a.accounts.nu, amountCents: 70000 },
            { accountId: a.accounts.comida, amountCents: -70000 },
          ],
        })
      ).transactionId;
    });

    const balances = await balancesOf(a.userId);
    expect(balances.get(a.accounts.nu)).toBe(0);
    expect(balances.get(a.accounts.comida)).toBe(0);

    const { rows } = await pool.query('SELECT id FROM transactions WHERE id = ANY($1)', [[t1, t2]]);
    expect(rows).toHaveLength(2);
  });

  it('T-C08: reversa por magnitud, no cuenta por cuenta → ✅ éxito aunque ruteé por cuentas distintas', async () => {
    const a = fixture.a;
    let t1 = '';
    await withCommit(async (client) => {
      t1 = (
        await insertBalancedTransaction(client, {
          userId: a.userId,
          bookedAt: '2026-08-05',
          entries: [
            { accountId: a.accounts.nu, amountCents: -70000 },
            { accountId: a.accounts.comida, amountCents: 70000 },
          ],
        })
      ).transactionId;
    });

    const efectivoId = randomUUID();
    await withCommit(async (client) => {
      await insertAccount(client, { id: efectivoId, userId: a.userId, name: 'Efectivo', type: 'asset' });
      await insertBalancedTransaction(client, {
        userId: a.userId,
        bookedAt: '2026-08-06',
        reversesTransactionId: t1,
        entries: [
          { accountId: efectivoId, amountCents: 70000 },
          { accountId: a.accounts.transporte, amountCents: -70000 },
        ],
      });
    });

    expect(await countRows(pool, 'transactions')).toBe(2);
  });

  it('T-C09: reversa de magnitud distinta a la del original → ❌ P1009 en el COMMIT, T2 no existe', async () => {
    const a = fixture.a;
    let t1 = '';
    await withCommit(async (client) => {
      t1 = (
        await insertBalancedTransaction(client, {
          userId: a.userId,
          bookedAt: '2026-08-05',
          entries: [
            { accountId: a.accounts.nu, amountCents: -70000 },
            { accountId: a.accounts.comida, amountCents: 70000 },
          ],
        })
      ).transactionId;
    });

    await expectDeferredRejection(async (client) => {
      await insertBalancedTransaction(client, {
        userId: a.userId,
        bookedAt: '2026-08-06',
        reversesTransactionId: t1,
        entries: [
          { accountId: a.accounts.nu, amountCents: 60000 },
          { accountId: a.accounts.comida, amountCents: -60000 },
        ],
      });
    }, 'P1009');

    expect(await countRows(pool, 'transactions')).toBe(1);
  });

  it('T-C10: doble reversa del mismo original → ❌ 23505 en el INSERT, solo hay una reversa de T1', async () => {
    const a = fixture.a;
    let t1 = '';
    await withCommit(async (client) => {
      t1 = (
        await insertBalancedTransaction(client, {
          userId: a.userId,
          bookedAt: '2026-08-05',
          entries: [
            { accountId: a.accounts.nu, amountCents: -70000 },
            { accountId: a.accounts.comida, amountCents: 70000 },
          ],
        })
      ).transactionId;
    });
    await withCommit(async (client) => {
      await insertBalancedTransaction(client, {
        userId: a.userId,
        bookedAt: '2026-08-06',
        reversesTransactionId: t1,
        entries: [
          { accountId: a.accounts.nu, amountCents: 70000 },
          { accountId: a.accounts.comida, amountCents: -70000 },
        ],
      });
    });

    await withRollback(async (client) => {
      await expectImmediateRejection(
        client,
        () => insertTransaction(client, { userId: a.userId, bookedAt: '2026-08-07', reversesTransactionId: t1 }),
        '23505',
        'transactions',
      );
    });

    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM transactions WHERE reverses_transaction_id = $1',
      [t1],
    );
    expect(rows[0].n).toBe(1);
  });

  it('T-C11: reversa con cero entries → ❌ P1009 en el COMMIT (segundo disparo sobre transactions); T1 sigue revertible', async () => {
    const a = fixture.a;
    let t1 = '';
    await withCommit(async (client) => {
      t1 = (
        await insertBalancedTransaction(client, {
          userId: a.userId,
          bookedAt: '2026-08-05',
          entries: [
            { accountId: a.accounts.nu, amountCents: -70000 },
            { accountId: a.accounts.comida, amountCents: 70000 },
          ],
        })
      ).transactionId;
    });

    await expectDeferredRejection(async (client) => {
      await insertTransaction(client, {
        userId: a.userId,
        bookedAt: '2026-08-06',
        reversesTransactionId: t1,
      });
    }, 'P1009');

    // El índice único de reversa no debió quemarse: la reversa real todavía puede crearse.
    await withCommit(async (client) => {
      await insertBalancedTransaction(client, {
        userId: a.userId,
        bookedAt: '2026-08-07',
        reversesTransactionId: t1,
        entries: [
          { accountId: a.accounts.nu, amountCents: 70000 },
          { accountId: a.accounts.comida, amountCents: -70000 },
        ],
      });
    });

    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM transactions WHERE reverses_transaction_id = $1',
      [t1],
    );
    expect(rows[0].n).toBe(1);
  });

  it('T-C12: reverses_transaction_id apuntando a sí misma → ❌ 23514', async () => {
    await withRollback(async (client) => {
      const fx = await seedFixture(client);
      const selfId = randomUUID();
      await expectImmediateRejection(
        client,
        () =>
          client.query(
            'INSERT INTO transactions (id, user_id, booked_at, description, reverses_transaction_id) VALUES ($1, $2, $3, $4, $1)',
            [selfId, fx.a.userId, '2026-08-05', 'auto-reversa'],
          ),
        '23514',
        'transactions',
      );
    });
  });
});
