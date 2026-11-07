import { pool, closePool, withRollback } from '../setup/db';
import { expectImmediateRejection } from '../setup/expect-errcode';
import { seedFixture } from '../setup/fixture';
import { insertTransaction, insertEntry } from '../setup/ledger';

describe('Grupo B — propiedad desnormalizada (R3, U10, inmediato)', () => {
  afterAll(async () => {
    await closePool();
  });

  it('T-B01: tx de A; entry con user_id=B, account_id de A → ❌ P1003 en el INSERT', async () => {
    await withRollback(async (client) => {
      const { a, b } = await seedFixture(client);
      const transactionId = await insertTransaction(client, { userId: a.userId, bookedAt: '2026-08-05' });

      await expectImmediateRejection(
        client,
        () =>
          insertEntry(client, {
            transactionId,
            userId: b.userId,
            accountId: a.accounts.nu,
            amountCents: 70000,
          }),
        'P1003',
        'entries',
      );
    });
  });

  it('T-B02: tx de A; entry con user_id=A pero account_id de una cuenta de B → ❌ P1003 en el INSERT', async () => {
    await withRollback(async (client) => {
      const { a, b } = await seedFixture(client);
      const transactionId = await insertTransaction(client, { userId: a.userId, bookedAt: '2026-08-05' });

      await expectImmediateRejection(
        client,
        () =>
          insertEntry(client, {
            transactionId,
            userId: a.userId,
            accountId: b.accounts.nu,
            amountCents: 70000,
          }),
        'P1003',
        'entries',
      );
    });
  });

  it('T-B03: tx de A; entry con user_id=A y account_id de A → ✅ el entry existe', async () => {
    await withRollback(async (client) => {
      const { a } = await seedFixture(client);
      const transactionId = await insertTransaction(client, { userId: a.userId, bookedAt: '2026-08-05' });
      const entryId = await insertEntry(client, {
        transactionId,
        userId: a.userId,
        accountId: a.accounts.nu,
        amountCents: 70000,
      });

      const { rows } = await client.query('SELECT id FROM entries WHERE id = $1', [entryId]);
      expect(rows).toHaveLength(1);
    });
  });
});
