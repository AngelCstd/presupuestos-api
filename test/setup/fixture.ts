import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

/**
 * `profiles.id` referencia `auth.users.id` (§3.7 de ARCHITECTURE.md). En
 * el Postgres local, `auth.users` la crea el stub de TASK-auth
 * (test/setup/local-auth-stub.sql, aplicado por globalSetup) — hay que
 * insertar ahí primero o el INSERT en `profiles` truena por FK.
 *
 * `profiles` en sí es de TASK-auth y no existe todavía en este repo. Lo
 * único documentado con certeza (TASK-auth.md) es que tiene `id uuid`
 * igual a `auth.users.id`. Se inserta solo esa columna — es el mínimo
 * necesario y no depende de `deleted_at`/`timezone` (P-05/P-06, pendientes
 * aparte).
 */
async function insertProfile(client: PoolClient, id: string): Promise<void> {
  await client.query('INSERT INTO auth.users (id) VALUES ($1)', [id]);
  await client.query('INSERT INTO profiles (id) VALUES ($1)', [id]);
}

interface AccountParams {
  id: string;
  userId: string;
  name: string;
  type: string;
  rolloverType?: string | null;
  isSystem?: boolean;
  currency?: string;
  archivedAt?: string | null;
}

export async function insertAccount(client: PoolClient, params: AccountParams): Promise<void> {
  await client.query(
    `INSERT INTO accounts (id, user_id, name, type, currency, rollover_type, is_system, archived_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      params.id,
      params.userId,
      params.name,
      params.type,
      params.currency ?? 'MXN',
      params.rolloverType ?? null,
      params.isSystem ?? false,
      params.archivedAt ?? null,
    ],
  );
}

interface PeriodParams {
  id: string;
  userId: string;
  startsOn: string;
  endsOn: string;
  /** Opcional — Grupo S (`late-capture`) necesita periodos ya cerrados al sembrar. */
  closedAt?: string | null;
}

export async function insertPeriod(client: PoolClient, params: PeriodParams): Promise<void> {
  await client.query(
    `INSERT INTO budget_periods (id, user_id, starts_on, ends_on, closed_at) VALUES ($1, $2, $3, $4, $5)`,
    [params.id, params.userId, params.startsOn, params.endsOn, params.closedAt ?? null],
  );
}

export interface UserFixture {
  userId: string;
  accounts: {
    nu: string;
    tdc: string;
    porCobrarFer: string;
    comida: string;
    transporte: string;
    servicios: string;
    hogar: string;
    salud: string;
    personal: string;
    ahorro: string;
    sueldo: string;
    saldoInicial: string;
  };
  periods: {
    /** [2026-08-01, 2026-08-15] */
    p1: string;
    /** [2026-08-16, 2026-08-31] */
    p2: string;
  };
}

export interface Fixture {
  a: UserFixture;
  b: UserFixture;
}

async function seedUser(client: PoolClient, userId: string): Promise<UserFixture> {
  await insertProfile(client, userId);

  const accounts: UserFixture['accounts'] = {
    nu: randomUUID(),
    tdc: randomUUID(),
    porCobrarFer: randomUUID(),
    comida: randomUUID(),
    transporte: randomUUID(),
    servicios: randomUUID(),
    hogar: randomUUID(),
    salud: randomUUID(),
    personal: randomUUID(),
    ahorro: randomUUID(),
    sueldo: randomUUID(),
    saldoInicial: randomUUID(),
  };

  await insertAccount(client, { id: accounts.nu, userId, name: 'Nu', type: 'asset' });
  await insertAccount(client, { id: accounts.tdc, userId, name: 'TDC', type: 'liability' });
  await insertAccount(client, {
    id: accounts.porCobrarFer,
    userId,
    name: 'Por cobrar: Fer',
    type: 'receivable',
  });
  await insertAccount(client, {
    id: accounts.comida,
    userId,
    name: 'Comida',
    type: 'expense',
    rolloverType: 'reset',
  });
  await insertAccount(client, {
    id: accounts.transporte,
    userId,
    name: 'Transporte',
    type: 'expense',
    rolloverType: 'reset',
  });
  await insertAccount(client, {
    id: accounts.servicios,
    userId,
    name: 'Servicios',
    type: 'expense',
    rolloverType: 'accumulate',
  });
  await insertAccount(client, {
    id: accounts.hogar,
    userId,
    name: 'Hogar',
    type: 'expense',
    rolloverType: 'reset',
  });
  await insertAccount(client, {
    id: accounts.salud,
    userId,
    name: 'Salud',
    type: 'expense',
    rolloverType: 'accumulate',
  });
  await insertAccount(client, {
    id: accounts.personal,
    userId,
    name: 'Personal',
    type: 'expense',
    rolloverType: 'reset',
  });
  await insertAccount(client, {
    id: accounts.ahorro,
    userId,
    name: 'Ahorro',
    type: 'expense',
    rolloverType: 'accumulate',
  });
  await insertAccount(client, { id: accounts.sueldo, userId, name: 'Sueldo', type: 'income' });
  await insertAccount(client, {
    id: accounts.saldoInicial,
    userId,
    name: 'Saldo Inicial',
    type: 'equity',
    isSystem: true,
  });

  const periods: UserFixture['periods'] = { p1: randomUUID(), p2: randomUUID() };
  await insertPeriod(client, {
    id: periods.p1,
    userId,
    startsOn: '2026-08-01',
    endsOn: '2026-08-15',
  });
  await insertPeriod(client, {
    id: periods.p2,
    userId,
    startsOn: '2026-08-16',
    endsOn: '2026-08-31',
  });

  return { userId, accounts, periods };
}

/**
 * U22 — dos usuarios (A y B), cada uno con las 9 cuentas que sembraría
 * `fn_seed_new_user` (aún no existe: se insertan directo), más `Nu`
 * (asset), `TDC` (liability), `Por cobrar: Fer` (receivable), y dos
 * `budget_periods` contiguos.
 */
export async function seedFixture(client: PoolClient): Promise<Fixture> {
  const a = await seedUser(client, randomUUID());
  const b = await seedUser(client, randomUUID());
  return { a, b };
}
