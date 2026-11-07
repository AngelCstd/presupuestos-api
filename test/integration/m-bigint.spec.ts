import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { seedFixture } from '../setup/fixture';
import { pool } from '../setup/db';

/**
 * ⚠️ No va a funcionar hasta que exista `prisma/schema.prisma` con los
 * modelos reales y se corra `prisma generate` (fase de implementación,
 * U01+, fuera de esta sesión) — hoy solo hay un cliente sin schema
 * (`@prisma/client` genera un fallback vacío en el postinstall), así que
 * este test falla en tiempo de ejecución, no de compilación. Es el único
 * test de la suite que depende de Prisma Client en vez del cliente `pg`
 * crudo — el enunciado dice literalmente "vía Prisma": prueba la
 * fidelidad de BigInt de PRISMA, no de Postgres.
 *
 * Los nombres de modelo (`entry`, `transaction`) siguen la convención
 * idiomática de Prisma/NestJS — PascalCase singular con `@@map` a la
 * tabla snake_case plural — que tampoco está documentada literalmente en
 * ARCHITECTURE.md (solo el nombre físico de la tabla). Ajustar si el loop
 * nombra los modelos distinto.
 */
describe('Grupo M — BigInt vía Prisma (U23)', () => {
  const prisma = new PrismaClient();

  afterAll(async () => {
    await prisma.$disconnect();
    await pool.end();
  });

  it('T-M01: amount_cents > 2^53 se lee idéntico a través de Prisma', async () => {
    const client = await pool.connect();
    let userId: string;
    let accountId: string;
    let categoryId: string;
    try {
      await client.query('BEGIN');
      const fixture = await seedFixture(client);
      userId = fixture.a.userId;
      accountId = fixture.a.accounts.nu;
      categoryId = fixture.a.accounts.comida;
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const hugeAmount = 9_007_199_254_740_993n; // > Number.MAX_SAFE_INTEGER (2^53 - 1)
    const transactionId = randomUUID();

    // S-R1 (TASK-db.md §3.4/U24): transaction + entries SIEMPRE en la
    // misma transacción de DB — dos .create() sueltos auto-commitean por
    // separado, y el segundo (un solo entry) dispara R2 (P1002) contra sí
    // mismo. $transaction los agrupa en un solo COMMIT; el segundo entry
    // balancea a cero para que R1 tampoco truene.
    await prisma.$transaction([
      prisma.transaction.create({
        data: { id: transactionId, userId, bookedAt: new Date('2026-08-05'), description: 'BigInt fidelity' },
      }),
      prisma.entry.create({
        data: { id: randomUUID(), transactionId, userId, accountId, amountCents: hugeAmount },
      }),
      prisma.entry.create({
        data: { id: randomUUID(), transactionId, userId, accountId: categoryId, amountCents: -hugeAmount },
      }),
    ]);

    const entry = await prisma.entry.findFirstOrThrow({ where: { transactionId, amountCents: hugeAmount } });

    expect(typeof entry.amountCents).toBe('bigint');
    expect(entry.amountCents).toBe(hugeAmount);
  });
});
