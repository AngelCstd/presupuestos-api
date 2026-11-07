import { randomUUID } from 'node:crypto';
import { closePool, withRollback } from '../setup/db';
import { expectImmediateRejection } from '../setup/expect-errcode';
import { seedFixture } from '../setup/fixture';
import { insertBudgetEntry } from '../setup/ledger';

describe('Grupo J — soft delete y borrado de usuario', () => {
  afterAll(async () => {
    await closePool();
  });

  it('T-J01: DELETE FROM profiles con datos de A → ❌ 23503', async () => {
    await withRollback(async (client) => {
      const { a } = await seedFixture(client);
      await expectImmediateRejection(
        client,
        () => client.query('DELETE FROM profiles WHERE id = $1', [a.userId]),
        '23503',
        'profiles',
      );
    });
  });

  it('T-J02: UPDATE profiles SET deleted_at = now() → ✅; los datos de A siguen íntegros y consultables', async () => {
    await withRollback(async (client) => {
      const { a } = await seedFixture(client);
      await client.query('UPDATE profiles SET deleted_at = now() WHERE id = $1', [a.userId]);

      const { rows } = await client.query('SELECT count(*)::int AS n FROM accounts WHERE user_id = $1', [a.userId]);
      expect(rows[0].n).toBeGreaterThan(0);
    });
  });

  it('T-J03: information_schema.columns para transactions y entries → no existe deleted_at en ninguna', async () => {
    await withRollback(async (client) => {
      // "no existe deleted_at" es vacuamente cierto si las tablas ni
      // siquiera existen. Se exige primero que SÍ tengan su columna
      // `amount_cents` (entries) / `booked_at` (transactions) para que
      // este test no pueda pasar contra una base vacía.
      const realColumns = await client.query(
        `SELECT table_name, column_name FROM information_schema.columns
         WHERE table_schema = 'public'
           AND (
             (table_name = 'entries' AND column_name = 'amount_cents')
             OR (table_name = 'transactions' AND column_name = 'booked_at')
           )`,
      );
      expect(realColumns.rows).toHaveLength(2);

      const { rows } = await client.query(
        `SELECT table_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name IN ('transactions', 'entries') AND column_name = 'deleted_at'`,
      );
      expect(rows).toHaveLength(0);
    });
  });

  it('T-J04: soft delete de un budget_period → excluido de la resolución de periodo y de F3', async () => {
    await withRollback(async (client) => {
      const { a } = await seedFixture(client);
      await insertBudgetEntry(client, {
        userId: a.userId,
        periodId: a.periods.p1,
        categoryId: a.accounts.comida,
        amountCents: 100_000,
      });

      const before = await client.query('SELECT unassigned_cents FROM fn_unassigned_funds($1)', [a.userId]);

      await client.query('UPDATE budget_periods SET deleted_at = now() WHERE id = $1', [a.periods.p1]);

      const after = await client.query('SELECT unassigned_cents FROM fn_unassigned_funds($1)', [a.userId]);
      expect(after.rows[0].unassigned_cents).not.toBe(before.rows[0].unassigned_cents);

      // Excluido de la resolución de "periodo vigente que contiene una fecha".
      const { rows } = await client.query(
        `SELECT id FROM budget_periods WHERE user_id = $1 AND deleted_at IS NULL AND daterange(starts_on, ends_on, '[]') @> $2::date`,
        [a.userId, '2026-08-05'],
      );
      expect(rows).toHaveLength(0);
    });
  });

  it('T-J05: soft delete de un budget_entry → excluido de F2 y F3', async () => {
    await withRollback(async (client) => {
      const { a } = await seedFixture(client);
      const id = await insertBudgetEntry(client, {
        userId: a.userId,
        periodId: a.periods.p1,
        categoryId: a.accounts.comida,
        amountCents: 100_000,
      });

      const beforeFunds = await client.query('SELECT unassigned_cents FROM fn_unassigned_funds($1)', [a.userId]);

      await client.query('UPDATE budget_entries SET deleted_at = now() WHERE id = $1', [id]);

      const category = await client.query(
        'SELECT * FROM fn_category_balances($1, $2) WHERE category_id = $3',
        [a.userId, a.periods.p1, a.accounts.comida],
      );
      expect(category.rows[0]?.has_budget ?? false).toBe(false);

      const afterFunds = await client.query('SELECT unassigned_cents FROM fn_unassigned_funds($1)', [a.userId]);
      expect(afterFunds.rows[0].unassigned_cents).not.toBe(beforeFunds.rows[0].unassigned_cents);
    });
  });

  it('T-J06: soft delete de un recurring_template → excluido de la lista de vencidos', async () => {
    await withRollback(async (client) => {
      const { a } = await seedFixture(client);
      const id = randomUUID();
      await client.query(
        `INSERT INTO recurring_templates (id, user_id, name, category_id, amount_cents, day_of_month, next_due_on)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, a.userId, 'Wifi Totalplay', a.accounts.comida, 70000, 15, '2026-08-01'],
      );

      await client.query('UPDATE recurring_templates SET deleted_at = now() WHERE id = $1', [id]);

      const { rows } = await client.query(
        `SELECT id FROM recurring_templates
         WHERE user_id = $1 AND is_active = true AND deleted_at IS NULL AND next_due_on <= $2`,
        [a.userId, '2026-08-10'],
      );
      expect(rows).toHaveLength(0);
    });
  });
});
