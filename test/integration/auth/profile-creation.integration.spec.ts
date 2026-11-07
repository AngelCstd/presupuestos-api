import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { pool } from '../../setup/db';

// `EnsureProfileExists` (TASK-auth.md §"Mecánica de creación de profiles")
// tiene su SQL exacto documentado (INSERT ... ON CONFLICT DO UPDATE SET
// id = EXCLUDED.id RETURNING ...) y debe usar $queryRaw de Prisma, nunca
// prisma.profile.upsert(). Lo que NO está documentado es la forma exacta
// de la clase/método en TS — se infiere un servicio con constructor
// `(prisma: PrismaClient)` y método `ensure(userId): Promise<ProfileRow>`,
// ajustar si el loop de implementación la nombra distinto (igual que las
// firmas de F2/F3/F4 en TASK-db).
import { EnsureProfileExistsService } from '../../../src/auth/services/ensure-profile-exists.service';
import { ProfileDeletedException } from '../../../src/auth/exceptions/profile-deleted.exception';

async function insertAuthUser(id: string): Promise<void> {
  await pool.query('INSERT INTO auth.users (id) VALUES ($1)', [id]);
}

async function insertExistingProfile(id: string, updatedAt: Date, deletedAt: Date | null = null): Promise<void> {
  await pool.query(
    `INSERT INTO profiles (id, created_at, updated_at, deleted_at) VALUES ($1, $2, $2, $3)`,
    [id, updatedAt, deletedAt],
  );
}

describe('EnsureProfileExists — profile-creation.integration.spec.ts', () => {
  const prisma = new PrismaClient();
  let service: EnsureProfileExistsService;

  beforeAll(() => {
    service = new EnsureProfileExistsService(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await pool.end();
  });

  it('T-4: usuario sin fila previa → se crea en un solo query', async () => {
    const userId = randomUUID();
    await insertAuthUser(userId);

    const profile = await service.ensure(userId);

    expect(profile.id).toBe(userId);
    expect(profile.deletedAt).toBeNull();

    const { rows } = await pool.query('SELECT count(*)::int AS n FROM profiles WHERE id = $1', [userId]);
    expect(rows[0].n).toBe(1);
  });

  it('T-5: usuario con fila ya existente → se retorna sin modificar updated_at', async () => {
    const userId = randomUUID();
    await insertAuthUser(userId);
    const originalUpdatedAt = new Date('2026-01-01T00:00:00.000Z');
    await insertExistingProfile(userId, originalUpdatedAt);

    const profile = await service.ensure(userId);

    expect(profile.id).toBe(userId);
    expect(new Date(profile.updatedAt).getTime()).toBe(originalUpdatedAt.getTime());
  });

  it('T-6: updated_at idéntico entre dos requests seguidos del mismo usuario existente', async () => {
    const userId = randomUUID();
    await insertAuthUser(userId);
    const originalUpdatedAt = new Date('2026-01-01T00:00:00.000Z');
    await insertExistingProfile(userId, originalUpdatedAt);

    const first = await service.ensure(userId);
    const second = await service.ensure(userId);

    expect(new Date(first.updatedAt).getTime()).toBe(new Date(second.updatedAt).getTime());
    expect(new Date(second.updatedAt).getTime()).toBe(originalUpdatedAt.getTime());
  });

  it('T-7: concurrencia — dos ensure() en paralelo para el mismo usuario nuevo, ninguna falla por PK', async () => {
    const userId = randomUUID();
    await insertAuthUser(userId);

    const [a, b] = await Promise.all([service.ensure(userId), service.ensure(userId)]);

    expect(a.id).toBe(userId);
    expect(b.id).toBe(userId);

    const { rows } = await pool.query('SELECT count(*)::int AS n FROM profiles WHERE id = $1', [userId]);
    expect(rows[0].n).toBe(1);
  });

  it('T-8: usuario con deleted_at IS NOT NULL → ProfileDeletedException, sin reactivación', async () => {
    const userId = randomUUID();
    await insertAuthUser(userId);
    const deletedAt = new Date('2026-01-01T00:00:00.000Z');
    await insertExistingProfile(userId, deletedAt, deletedAt);

    await expect(service.ensure(userId)).rejects.toBeInstanceOf(ProfileDeletedException);

    const { rows } = await pool.query('SELECT deleted_at FROM profiles WHERE id = $1', [userId]);
    expect(rows[0].deleted_at).not.toBeNull();
  });

  // P-07 (TASK-db.md) resuelto aquí: `ensure()` es el punto de invocación
  // de `fn_seed_new_user` — corre en la misma transacción que el upsert
  // de `profiles`, solo cuando esta llamada de verdad insertó la fila
  // (nunca en la rama "ya existía"). Reducida a la cuenta de sistema
  // (equity) — ARCHITECTURE.md §3.12 revisado.

  it('T-4b: usuario sin fila previa → además de profiles, se siembra la cuenta de sistema (equity), nada más', async () => {
    const userId = randomUUID();
    await insertAuthUser(userId);

    await service.ensure(userId);

    const { rows: equity } = await pool.query(
      `SELECT name, is_system FROM accounts WHERE user_id = $1 AND type = 'equity'`,
      [userId],
    );
    expect(equity).toEqual([{ name: 'Saldo Inicial', is_system: true }]);

    const { rows: total } = await pool.query('SELECT count(*)::int AS n FROM accounts WHERE user_id = $1', [userId]);
    expect(total[0].n).toBe(1);
  });

  it('T-5b: usuario con fila ya existente (creada fuera de ensure()) → ensure() NO vuelve a sembrar', async () => {
    const userId = randomUUID();
    await insertAuthUser(userId);
    await insertExistingProfile(userId, new Date('2026-01-01T00:00:00.000Z'));

    await service.ensure(userId);

    const { rows } = await pool.query('SELECT count(*)::int AS n FROM accounts WHERE user_id = $1', [userId]);
    expect(rows[0].n).toBe(0);
  });

  it('T-7b: concurrencia — dos ensure() en paralelo para el mismo usuario nuevo dejan UNA sola cuenta de sistema', async () => {
    const userId = randomUUID();
    await insertAuthUser(userId);

    await Promise.all([service.ensure(userId), service.ensure(userId)]);

    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM accounts WHERE user_id = $1 AND type = 'equity'`,
      [userId],
    );
    expect(rows[0].n).toBe(1);
  });
});
