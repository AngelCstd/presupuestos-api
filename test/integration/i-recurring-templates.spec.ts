import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { closePool, withRollback } from '../setup/db';
import { expectImmediateRejection } from '../setup/expect-errcode';
import { seedFixture } from '../setup/fixture';

/**
 * T-I07 y T-I08 prueban los CHECKs de `recurring_templates` (U08a), no la
 * función pura `nextDueOn` (U08b) — por eso viven aquí y no en
 * test/unit/next-due-on.spec.ts (que solo cubre T-I01-I06, sin DB). No
 * encajan en el árbol de archivos de TASK-db.md §9 (Grupo I no tiene un
 * archivo de integración listado); se agregan con el mismo criterio que
 * `m-bigint.spec.ts`.
 */
describe('Grupo I — CHECKs de recurring_templates (U08a)', () => {
  afterAll(async () => {
    await closePool();
  });

  async function insertRecurringTemplate(
    client: PoolClient,
    params: { userId: string; categoryId: string; dayOfMonth: number; amountCents: number },
  ) {
    await client.query(
      `INSERT INTO recurring_templates (id, user_id, name, category_id, amount_cents, day_of_month, next_due_on)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [randomUUID(), params.userId, 'Wifi Totalplay', params.categoryId, params.amountCents, params.dayOfMonth, '2026-09-01'],
    );
  }

  it.each([0, 32])('T-I07: day_of_month=%i → ❌ 23514', async (dayOfMonth) => {
    await withRollback(async (client) => {
      const { a } = await seedFixture(client);
      await expectImmediateRejection(
        client,
        () => insertRecurringTemplate(client, { userId: a.userId, categoryId: a.accounts.comida, dayOfMonth, amountCents: 70000 }),
        '23514',
        'recurring_templates',
      );
    });
  });

  it.each([0, -100])('T-I08: amount_cents=%i → ❌ 23514', async (amountCents) => {
    await withRollback(async (client) => {
      const { a } = await seedFixture(client);
      await expectImmediateRejection(
        client,
        () => insertRecurringTemplate(client, { userId: a.userId, categoryId: a.accounts.comida, dayOfMonth: 15, amountCents }),
        '23514',
        'recurring_templates',
      );
    });
  });
});
