import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { createTestApp, type TestAppHandle } from '../_helpers/app';
import { bearerFor } from '../_helpers/auth';
import { pool, seedFixtureCommitted, type Fixture } from '../_helpers/seed';
import { insertBalancedTransaction } from '../../../setup/ledger';

// Grupo G — cuentas (TASK-api.md §11, T-G01–G17). AccountsModule no existe
// todavía — rojo por diseño.
import { AccountsModule } from '../../../../src/accounts/accounts.module';

/** Inserta una transacción balanceada YA COMMIT, visible para la app bajo prueba. */
async function commitBalancedTransaction(params: {
  userId: string;
  bookedAt: string;
  entries: Array<{ accountId: string; amountCents: number }>;
  description?: string;
}): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await insertBalancedTransaction(client, params);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

describe('AccountsModule — accounts.integration.spec.ts (Grupo G)', () => {
  let app: INestApplication;
  let moduleRef: TestAppHandle['moduleRef'];
  let handle: TestAppHandle;
  let fixture: Fixture;
  let authA: string;
  let authB: string;

  beforeAll(async () => {
    fixture = await seedFixtureCommitted();
    authA = bearerFor(fixture.a.userId);
    authB = bearerFor(fixture.b.userId);

    handle = await createTestApp([AccountsModule]);
    app = handle.app;
    moduleRef = handle.moduleRef;
  });

  afterAll(async () => {
    await handle.close();
    await pool.end();
  });

  async function createAccount(name: string, kind = 'cash', auth = authA): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/accounts')
      .set('Authorization', auth)
      .send({ name, kind })
      .expect(201);
    return res.body.id as string;
  }

  it('T-G01: POST /accounts {name:"Nu Test",kind:"cash"} → 201, currency default MXN, balanceCents "0"', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/accounts')
      .set('Authorization', authA)
      .send({ name: 'Nu Test', kind: 'cash' })
      .expect(201);

    expect(res.body).toMatchObject({ name: 'Nu Test', kind: 'cash', currency: 'MXN', balanceCents: '0', archivedAt: null });
  });

  it('T-G02: segundo POST /accounts con nombre "duplicado" en minúsculas → 409 DUPLICATE_ACCOUNT_NAME, cero filas nuevas', async () => {
    await createAccount('Duplicado');
    const before = await pool.query('SELECT count(*)::int AS n FROM accounts WHERE user_id = $1', [fixture.a.userId]);

    const res = await request(app.getHttpServer())
      .post('/api/v1/accounts')
      .set('Authorization', authA)
      .send({ name: 'duplicado', kind: 'cash' })
      .expect(409);
    expect(res.body.code).toBe('DUPLICATE_ACCOUNT_NAME');

    const after = await pool.query('SELECT count(*)::int AS n FROM accounts WHERE user_id = $1', [fixture.a.userId]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it('T-G03: POST /accounts con kind:"category" o kind:"asset" → 400 VALIDATION_FAILED', async () => {
    for (const kind of ['category', 'asset']) {
      const res = await request(app.getHttpServer())
        .post('/api/v1/accounts')
        .set('Authorization', authA)
        .send({ name: `Kind inválido ${kind}`, kind })
        .expect(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    }
  });

  it('T-G04: POST /accounts con rolloverType:"reset" → 400 VALIDATION_FAILED (campo no declarado)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/accounts')
      .set('Authorization', authA)
      .send({ name: 'Con rollover', kind: 'cash', rolloverType: 'reset' })
      .expect(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
  });

  it('T-G05/T-G06: archivada — no aparece por default, sí con includeArchived=true, con archivedAt no nulo', async () => {
    const id = await createAccount('Para archivar G05');
    await request(app.getHttpServer()).post(`/api/v1/accounts/${id}/archive`).set('Authorization', authA).expect(200);

    const defaultList = await request(app.getHttpServer()).get('/api/v1/accounts').set('Authorization', authA).expect(200);
    expect(defaultList.body.data.some((a: { id: string }) => a.id === id)).toBe(false);

    const withArchived = await request(app.getHttpServer())
      .get('/api/v1/accounts?includeArchived=true')
      .set('Authorization', authA)
      .expect(200);
    const archivedRow = withArchived.body.data.find((a: { id: string }) => a.id === id);
    expect(archivedRow).toBeDefined();
    expect(archivedRow.archivedAt).not.toBeNull();
  });

  it('T-G07: GET /accounts con 3 cuentas → UNA sola llamada a accountBalances (spy sobre IQueryRepository, sin N+1)', async () => {
    await createAccount('Cta N+1 uno');
    await createAccount('Cta N+1 dos');
    await createAccount('Cta N+1 tres');

    const queryRepository = moduleRef.get('IQueryRepository', { strict: false }) as {
      accountBalances: (userId: string) => Promise<unknown>;
    };
    const spy = jest.spyOn(queryRepository, 'accountBalances');
    spy.mockClear();

    await request(app.getHttpServer()).get('/api/v1/accounts?pageSize=200').set('Authorization', authA).expect(200);

    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('T-G08: archivar cuenta asset con saldo 70000 → 409 ACCOUNT_NOT_EMPTY, archivedAt sigue nulo', async () => {
    const id = await createAccount('Con saldo G08');
    await commitBalancedTransaction({
      userId: fixture.a.userId,
      bookedAt: '2026-08-09',
      description: 'saldo G08',
      entries: [
        { accountId: id, amountCents: 70000 },
        { accountId: fixture.a.accounts.sueldo, amountCents: -70000 },
      ],
    });

    const res = await request(app.getHttpServer()).post(`/api/v1/accounts/${id}/archive`).set('Authorization', authA).expect(409);
    expect(res.body.code).toBe('ACCOUNT_NOT_EMPTY');

    const check = await request(app.getHttpServer()).get(`/api/v1/accounts/${id}`).set('Authorization', authA).expect(200);
    expect(check.body.archivedAt).toBeNull();
  });

  it('T-G09: archivar cuenta asset con saldo 0 → 200, archivedAt no nulo', async () => {
    const id = await createAccount('Sin saldo G09');
    const res = await request(app.getHttpServer()).post(`/api/v1/accounts/${id}/archive`).set('Authorization', authA).expect(200);
    expect(res.body.archivedAt).not.toBeNull();
  });

  it('T-G10: archivar receivable con saldo pendiente → 409 ACCOUNT_NOT_EMPTY (R8 cubre receivable)', async () => {
    const id = await createAccount('Por cobrar G10', 'receivable');
    await commitBalancedTransaction({
      userId: fixture.a.userId,
      bookedAt: '2026-08-09',
      description: 'préstamo G10',
      entries: [
        { accountId: id, amountCents: 20000 },
        { accountId: fixture.a.accounts.nu, amountCents: -20000 },
      ],
    });

    const res = await request(app.getHttpServer()).post(`/api/v1/accounts/${id}/archive`).set('Authorization', authA).expect(409);
    expect(res.body.code).toBe('ACCOUNT_NOT_EMPTY');
  });

  it('T-G11: archivar lo ya archivado → 409 ALREADY_ARCHIVED', async () => {
    const id = await createAccount('Ya archivada G11');
    await request(app.getHttpServer()).post(`/api/v1/accounts/${id}/archive`).set('Authorization', authA).expect(200);

    const res = await request(app.getHttpServer()).post(`/api/v1/accounts/${id}/archive`).set('Authorization', authA).expect(409);
    expect(res.body.code).toBe('ALREADY_ARCHIVED');
  });

  it('T-G12: desarchivar → 200, archivedAt nulo', async () => {
    const id = await createAccount('Para desarchivar G12');
    await request(app.getHttpServer()).post(`/api/v1/accounts/${id}/archive`).set('Authorization', authA).expect(200);

    const res = await request(app.getHttpServer()).post(`/api/v1/accounts/${id}/unarchive`).set('Authorization', authA).expect(200);
    expect(res.body.archivedAt).toBeNull();
  });

  it('T-G13: desarchivar cuando existe otra cuenta activa con el mismo nombre → 409 DUPLICATE_ACCOUNT_NAME', async () => {
    const firstId = await createAccount('Choque G13');
    await request(app.getHttpServer()).post(`/api/v1/accounts/${firstId}/archive`).set('Authorization', authA).expect(200);
    await createAccount('Choque G13');

    const res = await request(app.getHttpServer())
      .post(`/api/v1/accounts/${firstId}/unarchive`)
      .set('Authorization', authA)
      .expect(409);
    expect(res.body.code).toBe('DUPLICATE_ACCOUNT_NAME');
  });

  it('T-G14: PATCH currency con entries → 409 CURRENCY_LOCKED (S-R5)', async () => {
    const id = await createAccount('Con historial G14');
    await commitBalancedTransaction({
      userId: fixture.a.userId,
      bookedAt: '2026-08-09',
      description: 'mov G14',
      entries: [
        { accountId: id, amountCents: 1000 },
        { accountId: fixture.a.accounts.sueldo, amountCents: -1000 },
      ],
    });

    const res = await request(app.getHttpServer())
      .patch(`/api/v1/accounts/${id}`)
      .set('Authorization', authA)
      .send({ currency: 'USD' })
      .expect(409);
    expect(res.body.code).toBe('CURRENCY_LOCKED');
  });

  it('T-G15: PATCH currency sin entries → 200', async () => {
    const id = await createAccount('Sin historial G15');
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/accounts/${id}`)
      .set('Authorization', authA)
      .send({ currency: 'USD' })
      .expect(200);
    expect(res.body.currency).toBe('USD');
  });

  // T-G16 — movido a Grupo O (T-O15) y reformulado con saldo cero, ver
  // TASK-api.md, nota bajo la tabla de Grupo G. La redacción original
  // ("cuenta archivada CON SALDO sigue contando en
  // GET /insights/account-balances") es estructuralmente inalcanzable
  // por HTTP en cualquier loop: R8 exige saldo EXACTO CERO para que
  // `POST /accounts/{id}/archive` tenga éxito, así que un archivado vía
  // HTTP normal jamás deja una cuenta con saldo distinto de cero — no es
  // solo que /insights sea loop 2. La garantía de S-R4 con saldo
  // DISTINTO de cero (el caso real que importa) ya está probada donde SÍ
  // es alcanzable: T-OC02, con SQL directo, sin pasar por el Service.

  it('T-G17: GET /accounts/{id} de U2 estando autenticado como A → 404 ACCOUNT_NOT_FOUND', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/accounts/${fixture.b.accounts.nu}`)
      .set('Authorization', authA)
      .expect(404);
    expect(res.body.code).toBe('ACCOUNT_NOT_FOUND');
  });
});
