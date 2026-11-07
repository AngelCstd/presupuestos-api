import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { createTestApp, type TestAppHandle } from '../_helpers/app';
import { bearerFor } from '../_helpers/auth';
import { pool, seedFixtureCommitted, type Fixture } from '../_helpers/seed';
import { insertAccount } from '../../../setup/fixture';

// Grupo I — consulta de ledger y paginación (TASK-api.md §11, T-I01–I10).
// TransactionsModule no existe todavía — rojo por diseño. AccountsModule
// sí existe (loop 1, A05) — T-I09 lo necesita real.
import { TransactionsModule } from '../../../../src/transactions/transactions.module';
import { AccountsModule } from '../../../../src/accounts/accounts.module';

interface TransactionListItem {
  id: string;
  bookedAt: string;
  movements: Array<{ accountId: string; accountName: string; accountKind: string; amountCents: string }>;
}

describe('TransactionsModule — transactions-query.integration.spec.ts (Grupo I)', () => {
  let app: INestApplication;
  let handle: TestAppHandle;
  let fixture: Fixture;
  let authA: string;
  let authB: string;

  beforeAll(async () => {
    fixture = await seedFixtureCommitted();
    authA = bearerFor(fixture.a.userId);
    authB = bearerFor(fixture.b.userId);

    handle = await createTestApp([TransactionsModule, AccountsModule]);
    app = handle.app;
  });

  afterAll(async () => {
    await handle.close();
    await pool.end();
  });

  function post(path: string, auth: string, body: Record<string, unknown>, idemKey = randomUUID()) {
    return request(app.getHttpServer()).post(path).set('Authorization', auth).set('Idempotency-Key', idemKey).send(body);
  }

  async function createExpense(
    auth: string,
    accounts: { paidFrom: string; category: string },
    bookedAt: string,
    idemKey = randomUUID(),
  ): Promise<string> {
    const res = await post(
      '/api/v1/transactions/expenses',
      auth,
      {
        bookedAt,
        description: `gasto ${bookedAt}`,
        paidFromAccountId: accounts.paidFrom,
        totalCents: '1000',
        lines: [{ categoryId: accounts.category, amountCents: '1000' }],
      },
      idemKey,
    ).expect(201);
    return res.body.id as string;
  }

  describe('T-I01/T-I02: 120 transacciones, paginación por cursor completa', () => {
    let pag: Fixture['a'];
    let authPag: string;

    beforeAll(async () => {
      const pagFixture = await seedFixtureCommitted();
      pag = pagFixture.a;
      authPag = bearerFor(pag.userId);

      for (let i = 0; i < 120; i += 1) {
        const bookedAt = `2026-0${1 + Math.floor(i / 28)}-${String(1 + (i % 28)).padStart(2, '0')}`;
        await createExpense(authPag, { paidFrom: pag.accounts.tdc, category: pag.accounts.comida }, bookedAt);
      }
    }, 60_000);

    it('T-I01: GET /transactions?limit=50 → 50 filas, nextCursor no nulo', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/transactions?limit=50')
        .set('Authorization', authPag)
        .expect(200);
      expect(res.body.data).toHaveLength(50);
      expect(res.body.nextCursor).not.toBeNull();
    });

    it('T-I02: paginar con nextCursor hasta agotar → 120 filas en total, cero duplicados, nextCursor final null', async () => {
      const seen = new Set<string>();
      let cursor: string | null = null;
      let pages = 0;

      do {
        const query = cursor ? `?limit=50&cursor=${encodeURIComponent(cursor)}` : '?limit=50';
        const res: request.Response = await request(app.getHttpServer())
          .get(`/api/v1/transactions${query}`)
          .set('Authorization', authPag)
          .expect(200);
        for (const item of res.body.data as TransactionListItem[]) {
          expect(seen.has(item.id)).toBe(false);
          seen.add(item.id);
        }
        cursor = res.body.nextCursor;
        pages += 1;
        expect(pages).toBeLessThan(10); // guarda contra loop infinito si nextCursor nunca cierra
      } while (cursor !== null);

      expect(seen.size).toBe(120);
    });
  });

  describe('T-I03: dos transacciones con el mismo bookedAt en el límite de página', () => {
    it('T-I03: el desempate por id funciona — ninguna se pierde ni se repite', async () => {
      const tieFixture = await seedFixtureCommitted();
      const authTie = bearerFor(tieFixture.a.userId);
      const accounts = { paidFrom: tieFixture.a.accounts.tdc, category: tieFixture.a.accounts.comida };

      const id1 = await createExpense(authTie, accounts, '2026-08-05');
      const id2 = await createExpense(authTie, accounts, '2026-08-05');

      const page1 = await request(app.getHttpServer())
        .get('/api/v1/transactions?limit=1')
        .set('Authorization', authTie)
        .expect(200);
      expect(page1.body.data).toHaveLength(1);
      expect(page1.body.nextCursor).not.toBeNull();
      const firstId = page1.body.data[0].id as string;
      expect([id1, id2]).toContain(firstId);

      const page2 = await request(app.getHttpServer())
        .get(`/api/v1/transactions?limit=1&cursor=${encodeURIComponent(page1.body.nextCursor)}`)
        .set('Authorization', authTie)
        .expect(200);
      expect(page2.body.data).toHaveLength(1);
      const secondId = page2.body.data[0].id as string;
      expect(secondId).not.toBe(firstId);
      expect([id1, id2]).toContain(secondId);

      // Con exactamente 2 transacciones para este usuario y limit=1, las
      // dos páginas de arriba ya las agotaron — page2.nextCursor tiene
      // que ser null de verdad. Pedir una página 3 encadenando ese null
      // (`encodeURIComponent(null)` serializa el string literal "null",
      // que no decodifica como cursor) probaría el manejo de un cursor
      // roto, no el desempate — ya cubierto aparte por T-I04. La
      // aserción real de "ninguna se pierde ni se repite" ya quedó
      // demostrada arriba: page1 y page2 devolvieron cada una un id
      // distinto de {id1, id2}, cruzando exactamente el límite de página
      // donde ambas comparten bookedAt.
      expect(page2.body.nextCursor).toBeNull();
    });
  });

  it('T-I04 ❌: ?cursor=zzz → 400 INVALID_CURSOR', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/transactions?cursor=zzz')
      .set('Authorization', authA)
      .expect(400);
    expect(res.body.code).toBe('INVALID_CURSOR');
  });

  it('T-I05 ❌: ?limit=500 → 400 VALIDATION_FAILED (máximo 100)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/transactions?limit=500')
      .set('Authorization', authA)
      .expect(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
  });

  it('T-I06: GET /transactions?from=2026-08-01&to=2026-08-15 → solo las de ese rango, inclusivo en ambos extremos', async () => {
    const accounts = { paidFrom: fixture.a.accounts.tdc, category: fixture.a.accounts.transporte };
    const beforeRangeId = await createExpense(authA, accounts, '2026-07-31');
    const startId = await createExpense(authA, accounts, '2026-08-01');
    const insideId = await createExpense(authA, accounts, '2026-08-10');
    const endId = await createExpense(authA, accounts, '2026-08-15');
    const afterRangeId = await createExpense(authA, accounts, '2026-08-16');

    const res = await request(app.getHttpServer())
      .get('/api/v1/transactions?from=2026-08-01&to=2026-08-15&limit=100')
      .set('Authorization', authA)
      .expect(200);

    const ids = (res.body.data as TransactionListItem[]).map((t) => t.id);
    expect(ids).toEqual(expect.arrayContaining([startId, insideId, endId]));
    expect(ids).not.toContain(beforeRangeId);
    expect(ids).not.toContain(afterRangeId);
  });

  it('T-I07: GET /transactions?accountId=TDC → solo transacciones con al menos un entry contra TDC', async () => {
    const withTdcId = await createExpense(
      authA,
      { paidFrom: fixture.a.accounts.tdc, category: fixture.a.accounts.servicios },
      '2026-08-05',
    );
    await post('/api/v1/transactions/loans', authA, {
      bookedAt: '2026-08-05',
      description: 'sin TDC',
      fromAccountId: fixture.a.accounts.nu,
      receivableAccountId: fixture.a.accounts.porCobrarFer,
      amountCents: '100',
    }).expect(201);

    const res = await request(app.getHttpServer())
      .get(`/api/v1/transactions?accountId=${fixture.a.accounts.tdc}&limit=100`)
      .set('Authorization', authA)
      .expect(200);

    const ids = (res.body.data as TransactionListItem[]).map((t) => t.id);
    expect(ids).toContain(withTdcId);
    for (const item of res.body.data as TransactionListItem[]) {
      expect(item.movements.some((m) => m.accountId === fixture.a.accounts.tdc)).toBe(true);
    }
  });

  it('T-I08: GET /transactions/{id} — todos sus movements con accountKind; nunca "system" salvo saldo inicial (ancla omitida)', async () => {
    const expenseId = await createExpense(
      authA,
      { paidFrom: fixture.a.accounts.tdc, category: fixture.a.accounts.salud },
      '2026-08-05',
    );
    const expenseRes = await request(app.getHttpServer())
      .get(`/api/v1/transactions/${expenseId}`)
      .set('Authorization', authA)
      .expect(200);
    const kinds = new Map(
      (expenseRes.body.movements as TransactionListItem['movements']).map((m) => [m.accountId, m.accountKind]),
    );
    expect(kinds.get(fixture.a.accounts.tdc)).toBe('credit');
    expect(kinds.get(fixture.a.accounts.salud)).toBe('category');
    expect(Array.from(kinds.values())).not.toContain('system');

    const nu2 = randomUUID();
    const client: PoolClient = await pool.connect();
    try {
      await client.query('BEGIN');
      await insertAccount(client, { id: nu2, userId: fixture.a.userId, name: 'Nu T-I08', type: 'asset' });
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    const openingRes = await post('/api/v1/transactions/opening-balances', authA, {
      bookedAt: '2026-07-01',
      description: 'saldo inicial T-I08',
      balances: [{ accountId: nu2, balanceCents: '5000' }],
    }).expect(201);

    const openingGet = await request(app.getHttpServer())
      .get(`/api/v1/transactions/${openingRes.body.id}`)
      .set('Authorization', authA)
      .expect(200);
    const openingMovements = openingGet.body.movements as TransactionListItem['movements'];
    expect(openingMovements.some((m) => m.accountId === nu2)).toBe(true);
    expect(openingMovements.some((m) => m.accountId === fixture.a.accounts.saldoInicial)).toBe(false);
    expect(openingMovements.map((m) => m.accountKind)).not.toContain('system');
  });

  it('T-I09: GET /accounts con 63 cuentas direccionables y ?pageSize=25&page=2 → 25 filas, total real, page:2', async () => {
    const pageFixture = await seedFixtureCommitted();
    const authPage = bearerFor(pageFixture.a.userId);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (let i = 0; i < 60; i += 1) {
        await insertAccount(client, { id: randomUUID(), userId: pageFixture.a.userId, name: `Cta ${i}`, type: 'asset' });
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    const res = await request(app.getHttpServer())
      .get('/api/v1/accounts?pageSize=25&page=2')
      .set('Authorization', authPage)
      .expect(200);

    // `seedFixtureCommitted()` ya siembra 3 cuentas direccionables propias
    // (Nu, TDC, Por cobrar: Fer) además de las 60 que este test inserta —
    // el total real es 63, no 60. La paginación (25 filas, page 2) no
    // depende de ese número exacto; el total sí, y hay que verificarlo tal
    // cual es, no el que se asumió al escribir el test.
    expect(res.body.data).toHaveLength(25);
    expect(res.body.total).toBe(63);
    expect(res.body.page).toBe(2);
  });

  it('T-I10 ❌: GET /transactions como U2 con datos de U1 → lista vacía, nunca filas de otro usuario', async () => {
    await createExpense(
      authA,
      { paidFrom: fixture.a.accounts.tdc, category: fixture.a.accounts.ahorro },
      '2026-08-05',
    );

    // Positivo primero: U1 sí tiene transacciones visibles para sí mismo —
    // si no, la lista vacía de U2 de abajo no probaría aislamiento, solo
    // que no hay nada que fugar.
    const asA = await request(app.getHttpServer())
      .get('/api/v1/transactions?limit=100')
      .set('Authorization', authA)
      .expect(200);
    expect(asA.body.data.length).toBeGreaterThan(0);

    const asB = await request(app.getHttpServer())
      .get('/api/v1/transactions?limit=100')
      .set('Authorization', authB)
      .expect(200);
    expect(asB.body.data).toEqual([]);
  });
});
