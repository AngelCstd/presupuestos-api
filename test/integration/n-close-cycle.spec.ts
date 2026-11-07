import type { PoolClient } from 'pg';
import { closePool, withRollback } from '../setup/db';
import { expectImmediateRejection } from '../setup/expect-errcode';
import { seedFixture } from '../setup/fixture';
import { insertBalancedTransaction, insertBudgetEntry } from '../setup/ledger';

/**
 * ⚠️ Confirmado con Luis: el algoritmo de cierre real es un Service, fuera
 * de alcance de esta capa (§3.10, §5.3). Estos tests NO lo ejecutan —
 * insertan a mano los `budget_entries` que el cierre produciría y
 * verifican que F2/F3/R11 reaccionan correctamente. Es lo máximo
 * verificable desde la capa de datos.
 *
 * Las comparaciones de F3 son siempre relativas (antes/después), como
 * hace TASK-db.md en T-N02 y T-G17: así no dependen de un valor absoluto
 * de `dinero_real` que este archivo tendría que inventar.
 */
describe('Grupo N — efectos del ciclo de cierre (§5.3, sin ejecutar el algoritmo real)', () => {
  afterAll(async () => {
    await closePool();
  });

  async function categoryBalance(client: PoolClient, userId: string, periodId: string, categoryId: string) {
    const { rows } = await client.query('SELECT * FROM fn_category_balances($1, $2) WHERE category_id = $3', [
      userId,
      periodId,
      categoryId,
    ]);
    return rows[0] as { assigned_cents: number; spent_cents: number; available_cents: number; has_budget: boolean } | undefined;
  }

  async function unassignedFunds(client: PoolClient, userId: string): Promise<number> {
    const { rows } = await client.query('SELECT unassigned_cents FROM fn_unassigned_funds($1)', [userId]);
    return rows[0]?.unassigned_cents as number;
  }

  it('T-N01: accumulate con sobrante — F2 de P2 muestra asignado=150000; F3 cuenta el compromiso una sola vez', async () => {
    await withRollback(async (client) => {
      const { a } = await seedFixture(client);
      await insertBudgetEntry(client, { userId: a.userId, periodId: a.periods.p1, categoryId: a.accounts.servicios, amountCents: 200_000 });
      await insertBalancedTransaction(client, {
        userId: a.userId,
        bookedAt: '2026-08-05',
        entries: [
          { accountId: a.accounts.nu, amountCents: -50_000 },
          { accountId: a.accounts.servicios, amountCents: 50_000 },
        ],
      });
      // disponible P1 Servicios = 150000, con P1 todavía abierto.
      const beforeClose = await unassignedFunds(client, a.userId);

      await insertBudgetEntry(client, {
        userId: a.userId,
        periodId: a.periods.p2,
        categoryId: a.accounts.servicios,
        amountCents: 150_000,
        source: 'rollover',
        note: 'rollover Servicios desde P1',
      });
      await client.query('UPDATE budget_periods SET closed_at = now() WHERE id = $1', [a.periods.p1]);

      const p2 = await categoryBalance(client, a.userId, a.periods.p2, a.accounts.servicios);
      expect(p2?.assigned_cents).toBe(150_000);

      // El compromiso (150000) sigue siendo el mismo: antes vía P1 abierto,
      // después vía P2 con P1 ya cerrado — contado una sola vez, no dos.
      const afterClose = await unassignedFunds(client, a.userId);
      expect(afterClose).toBe(beforeClose);
    });
  });

  it('T-N02: reset con sobrante NO arrastra — has_budget=false en P2; F3 sube respecto al estado con P1 abierto', async () => {
    await withRollback(async (client) => {
      const { a } = await seedFixture(client);
      await insertBudgetEntry(client, { userId: a.userId, periodId: a.periods.p1, categoryId: a.accounts.comida, amountCents: 200_000 });
      await insertBalancedTransaction(client, {
        userId: a.userId,
        bookedAt: '2026-08-05',
        entries: [
          { accountId: a.accounts.nu, amountCents: -50_000 },
          { accountId: a.accounts.comida, amountCents: 50_000 },
        ],
      });

      const beforeClose = await unassignedFunds(client, a.userId);

      // No se inserta rollover: el sobrante de `reset` se libera.
      await client.query('UPDATE budget_periods SET closed_at = now() WHERE id = $1', [a.periods.p1]);

      const p2 = await categoryBalance(client, a.userId, a.periods.p2, a.accounts.comida);
      expect(p2?.has_budget ?? false).toBe(false);

      const afterClose = await unassignedFunds(client, a.userId);
      expect(afterClose).toBe(beforeClose + 150_000);
    });
  });

  it('T-N03: sobregiro se arrastra en accumulate — F2 P2 asignado=-30000; F3 lo sigue contando como compromiso de +30000', async () => {
    await withRollback(async (client) => {
      const { a } = await seedFixture(client);
      await insertBudgetEntry(client, { userId: a.userId, periodId: a.periods.p1, categoryId: a.accounts.servicios, amountCents: 100_000 });
      await insertBalancedTransaction(client, {
        userId: a.userId,
        bookedAt: '2026-08-05',
        entries: [
          { accountId: a.accounts.nu, amountCents: -130_000 },
          { accountId: a.accounts.servicios, amountCents: 130_000 },
        ],
      });
      // disponible P1 Servicios = -30000, con P1 todavía abierto.
      const beforeClose = await unassignedFunds(client, a.userId);

      await insertBudgetEntry(client, {
        userId: a.userId,
        periodId: a.periods.p2,
        categoryId: a.accounts.servicios,
        amountCents: -30_000,
        source: 'rollover',
        note: 'sobregiro arrastrado desde P1',
      });
      await client.query('UPDATE budget_periods SET closed_at = now() WHERE id = $1', [a.periods.p1]);

      const p2 = await categoryBalance(client, a.userId, a.periods.p2, a.accounts.servicios);
      expect(p2?.assigned_cents).toBe(-30_000);

      // El déficit (+30000 de compromiso) sigue contando igual, ahora vía P2.
      const afterClose = await unassignedFunds(client, a.userId);
      expect(afterClose).toBe(beforeClose);
    });
  });

  it('T-N04: sobregiro se arrastra también en reset — mismo comportamiento que T-N03', async () => {
    await withRollback(async (client) => {
      const { a } = await seedFixture(client);
      await insertBudgetEntry(client, { userId: a.userId, periodId: a.periods.p1, categoryId: a.accounts.comida, amountCents: 100_000 });
      await insertBalancedTransaction(client, {
        userId: a.userId,
        bookedAt: '2026-08-05',
        entries: [
          { accountId: a.accounts.nu, amountCents: -130_000 },
          { accountId: a.accounts.comida, amountCents: 130_000 },
        ],
      });
      const beforeClose = await unassignedFunds(client, a.userId);

      await insertBudgetEntry(client, {
        userId: a.userId,
        periodId: a.periods.p2,
        categoryId: a.accounts.comida,
        amountCents: -30_000,
        source: 'rollover',
        note: 'sobregiro arrastrado desde P1 (reset)',
      });
      await client.query('UPDATE budget_periods SET closed_at = now() WHERE id = $1', [a.periods.p1]);

      const p2 = await categoryBalance(client, a.userId, a.periods.p2, a.accounts.comida);
      expect(p2?.assigned_cents).toBe(-30_000);

      const afterClose = await unassignedFunds(client, a.userId);
      expect(afterClose).toBe(beforeClose);
    });
  });

  it('T-N05: doble materialización imposible — segundo rollover para (P2, Servicios) → ❌ 23505', async () => {
    await withRollback(async (client) => {
      const { a } = await seedFixture(client);
      await insertBudgetEntry(client, {
        userId: a.userId,
        periodId: a.periods.p2,
        categoryId: a.accounts.servicios,
        amountCents: 150_000,
        source: 'rollover',
      });

      await expectImmediateRejection(
        client,
        () =>
          insertBudgetEntry(client, {
            userId: a.userId,
            periodId: a.periods.p2,
            categoryId: a.accounts.servicios,
            amountCents: 150_000,
            source: 'rollover',
          }),
        '23505',
        'budget_entries',
      );
    });
  });

  it('T-N06: cierre desordenado — insertar el rollover de P1 en P2 ya cerrado → ❌ P1011', async () => {
    await withRollback(async (client) => {
      const { a } = await seedFixture(client);
      await client.query('UPDATE budget_periods SET closed_at = now() WHERE id = $1', [a.periods.p2]);

      await expectImmediateRejection(
        client,
        () =>
          insertBudgetEntry(client, {
            userId: a.userId,
            periodId: a.periods.p2,
            categoryId: a.accounts.servicios,
            amountCents: 150_000,
            source: 'rollover',
            note: 'rollover de P1, pero P2 ya está cerrado',
          }),
        'P1011',
        'budget_entries',
      );
    });
  });
});
