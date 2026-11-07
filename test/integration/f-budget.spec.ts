import { closePool, withRollback } from '../setup/db';
import { expectImmediateRejection } from '../setup/expect-errcode';
import { seedFixture } from '../setup/fixture';
import { insertBudgetEntry } from '../setup/ledger';

describe('Grupo F — budget_entries: R7, unicidad de rollover, R11 (U07, U13, U15)', () => {
  afterAll(async () => {
    await closePool();
  });

  it('T-F01: category_id de cuenta asset → ❌ P1007', async () => {
    await withRollback(async (client) => {
      const { a } = await seedFixture(client);
      await expectImmediateRejection(
        client,
        () =>
          insertBudgetEntry(client, {
            userId: a.userId,
            periodId: a.periods.p1,
            categoryId: a.accounts.nu,
            amountCents: 10000,
          }),
        'P1007',
        'budget_entries',
      );
    });
  });

  it('T-F02: category_id de cuenta income → ❌ P1007', async () => {
    await withRollback(async (client) => {
      const { a } = await seedFixture(client);
      await expectImmediateRejection(
        client,
        () =>
          insertBudgetEntry(client, {
            userId: a.userId,
            periodId: a.periods.p1,
            categoryId: a.accounts.sueldo,
            amountCents: 10000,
          }),
        'P1007',
        'budget_entries',
      );
    });
  });

  it('T-F03: category_id de cuenta receivable → ❌ P1007', async () => {
    await withRollback(async (client) => {
      const { a } = await seedFixture(client);
      await expectImmediateRejection(
        client,
        () =>
          insertBudgetEntry(client, {
            userId: a.userId,
            periodId: a.periods.p1,
            categoryId: a.accounts.porCobrarFer,
            amountCents: 10000,
          }),
        'P1007',
        'budget_entries',
      );
    });
  });

  it('T-F04: category_id de cuenta expense del mismo usuario → ✅', async () => {
    await withRollback(async (client) => {
      const { a } = await seedFixture(client);
      const id = await insertBudgetEntry(client, {
        userId: a.userId,
        periodId: a.periods.p1,
        categoryId: a.accounts.comida,
        amountCents: 100000,
      });
      const { rows } = await client.query('SELECT id FROM budget_entries WHERE id = $1', [id]);
      expect(rows).toHaveLength(1);
    });
  });

  it('T-F05: amount_cents = 0 → ❌ 23514', async () => {
    await withRollback(async (client) => {
      const { a } = await seedFixture(client);
      await expectImmediateRejection(
        client,
        () =>
          insertBudgetEntry(client, {
            userId: a.userId,
            periodId: a.periods.p1,
            categoryId: a.accounts.comida,
            amountCents: 0,
          }),
        '23514',
        'budget_entries',
      );
    });
  });

  it('T-F06: amount_cents = -30000 → ✅ (desasignar / arrastre de sobregiro)', async () => {
    await withRollback(async (client) => {
      const { a } = await seedFixture(client);
      const id = await insertBudgetEntry(client, {
        userId: a.userId,
        periodId: a.periods.p2,
        categoryId: a.accounts.servicios,
        amountCents: -30000,
        source: 'rollover',
        note: 'sobregiro arrastrado',
      });
      const { rows } = await client.query('SELECT amount_cents FROM budget_entries WHERE id = $1', [id]);
      expect(rows[0].amount_cents).toBe(-30000);
    });
  });

  it('T-F07: dos source=rollover vigentes para (P2, Comida) → ❌ 23505', async () => {
    await withRollback(async (client) => {
      const { a } = await seedFixture(client);
      await insertBudgetEntry(client, {
        userId: a.userId,
        periodId: a.periods.p2,
        categoryId: a.accounts.comida,
        amountCents: 50000,
        source: 'rollover',
      });

      await expectImmediateRejection(
        client,
        () =>
          insertBudgetEntry(client, {
            userId: a.userId,
            periodId: a.periods.p2,
            categoryId: a.accounts.comida,
            amountCents: 20000,
            source: 'rollover',
          }),
        '23505',
        'budget_entries',
      );
    });
  });

  it('T-F08: marcar el primer rollover con deleted_at, insertar otro para (P2, Comida) → ✅ éxito', async () => {
    await withRollback(async (client) => {
      const { a } = await seedFixture(client);
      const firstId = await insertBudgetEntry(client, {
        userId: a.userId,
        periodId: a.periods.p2,
        categoryId: a.accounts.comida,
        amountCents: 50000,
        source: 'rollover',
      });
      await client.query('UPDATE budget_entries SET deleted_at = now() WHERE id = $1', [firstId]);

      const secondId = await insertBudgetEntry(client, {
        userId: a.userId,
        periodId: a.periods.p2,
        categoryId: a.accounts.comida,
        amountCents: 20000,
        source: 'rollover',
      });

      const { rows } = await client.query('SELECT id FROM budget_entries WHERE id = $1', [secondId]);
      expect(rows).toHaveLength(1);
    });
  });

  it('T-F09: tres source=manual para (P1, Comida) → ✅ los tres', async () => {
    await withRollback(async (client) => {
      const { a } = await seedFixture(client);
      await insertBudgetEntry(client, {
        userId: a.userId,
        periodId: a.periods.p1,
        categoryId: a.accounts.comida,
        amountCents: 10000,
      });
      await insertBudgetEntry(client, {
        userId: a.userId,
        periodId: a.periods.p1,
        categoryId: a.accounts.comida,
        amountCents: 20000,
      });
      await insertBudgetEntry(client, {
        userId: a.userId,
        periodId: a.periods.p1,
        categoryId: a.accounts.comida,
        amountCents: 30000,
      });

      const { rows } = await client.query(
        `SELECT count(*)::int AS n FROM budget_entries WHERE period_id = $1 AND category_id = $2 AND source = 'manual'`,
        [a.periods.p1, a.accounts.comida],
      );
      expect(rows[0].n).toBe(3);
    });
  });

  it('T-F10: UPDATE amount_cents en periodo cerrado → ❌ P1011, monto sin cambio', async () => {
    await withRollback(async (client) => {
      const { a } = await seedFixture(client);
      const id = await insertBudgetEntry(client, {
        userId: a.userId,
        periodId: a.periods.p1,
        categoryId: a.accounts.comida,
        amountCents: 10000,
      });
      await client.query('UPDATE budget_periods SET closed_at = now() WHERE id = $1', [a.periods.p1]);

      await expectImmediateRejection(
        client,
        () => client.query('UPDATE budget_entries SET amount_cents = 99999 WHERE id = $1', [id]),
        'P1011',
        'budget_entries',
      );

      const { rows } = await client.query('SELECT amount_cents FROM budget_entries WHERE id = $1', [id]);
      expect(rows[0].amount_cents).toBe(10000);
    });
  });

  it('T-F11: UPDATE deleted_at = now() de un budget_entry en periodo cerrado → ❌ P1011 (cubre el soft delete)', async () => {
    await withRollback(async (client) => {
      const { a } = await seedFixture(client);
      const id = await insertBudgetEntry(client, {
        userId: a.userId,
        periodId: a.periods.p1,
        categoryId: a.accounts.comida,
        amountCents: 10000,
      });
      await client.query('UPDATE budget_periods SET closed_at = now() WHERE id = $1', [a.periods.p1]);

      await expectImmediateRejection(
        client,
        () => client.query('UPDATE budget_entries SET deleted_at = now() WHERE id = $1', [id]),
        'P1011',
        'budget_entries',
      );
    });
  });

  it('T-F12: UPDATE de un budget_entry con source=rollover en periodo cerrado → ❌ P1011', async () => {
    await withRollback(async (client) => {
      const { a } = await seedFixture(client);
      const id = await insertBudgetEntry(client, {
        userId: a.userId,
        periodId: a.periods.p1,
        categoryId: a.accounts.servicios,
        amountCents: 15000,
        source: 'rollover',
      });
      await client.query('UPDATE budget_periods SET closed_at = now() WHERE id = $1', [a.periods.p1]);

      await expectImmediateRejection(
        client,
        () => client.query('UPDATE budget_entries SET note = $1 WHERE id = $2', ['editado', id]),
        'P1011',
        'budget_entries',
      );
    });
  });

  it('T-F13: UPDATE amount_cents en periodo abierto → ✅ éxito', async () => {
    await withRollback(async (client) => {
      const { a } = await seedFixture(client);
      const id = await insertBudgetEntry(client, {
        userId: a.userId,
        periodId: a.periods.p1,
        categoryId: a.accounts.comida,
        amountCents: 10000,
      });

      await client.query('UPDATE budget_entries SET amount_cents = 20000 WHERE id = $1', [id]);

      const { rows } = await client.query('SELECT amount_cents FROM budget_entries WHERE id = $1', [id]);
      expect(rows[0].amount_cents).toBe(20000);
    });
  });
});
