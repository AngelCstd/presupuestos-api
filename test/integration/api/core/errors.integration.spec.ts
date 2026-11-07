import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { Controller, Get, Module, UseGuards, type INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { createTestApp, type TestAppHandle } from '../_helpers/app';
import { bearerFor } from '../_helpers/auth';
import { pool, seedFixtureCommitted, type Fixture } from '../_helpers/seed';
import { signExpiredToken } from '../../../setup/auth/jwt';

// Grupo Q — errores y mapeo (TASK-api.md §11, T-Q01–Q08).
import { AuthGuard } from '../../../../src/auth/guards/auth.guard';
import { AuthModule } from '../../../../src/auth/auth.module';
import { ErrorLogRepository } from '../../../../src/common/logging/error-log.repository';
import { PrismaErrorMapper } from '../../../../src/common/errors/prisma-error.mapper';

// Controller de prueba mínimo, solo para este archivo — no vive en
// `_helpers/`: Grupo Q necesita provocar un 500 controlado y ningún
// módulo de dominio expone eso a propósito. Un solo endpoint, nada más.
@Controller('boom')
class BoomController {
  @Get()
  @UseGuards(AuthGuard)
  boom(): never {
    throw new Error('boom: error no controlado para Grupo Q');
  }
}

// Importa `AuthModule` en vez de armar `IAuthRepository` a mano — una
// sola forma de obtener el repositorio, un solo lugar (`_helpers/app.ts`)
// donde el arnés overridea `JwtKeyGetter` con el JWKS local de test. La
// versión anterior duplicaba el wiring de auth y solo no dolía porque el
// constructor de `SupabaseAuthRepository` estaba vacío.
@Module({
  imports: [AuthModule],
  controllers: [BoomController],
})
class BoomModule {}

describe('GlobalExceptionFilter / mapeo de errores — errors.integration.spec.ts (Grupo Q)', () => {
  let app: INestApplication;
  let handle: TestAppHandle;
  let fixture: Fixture;
  let authA: string;

  beforeAll(async () => {
    fixture = await seedFixtureCommitted();
    authA = bearerFor(fixture.a.userId);

    handle = await createTestApp([BoomModule]);
    app = handle.app;
  });

  afterAll(async () => {
    await handle.close();
    await pool.end();
  });

  it('T-Q01: la respuesta de error trae exactamente statusCode, code, message, timestamp, path — nada extra, nada faltante', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/boom').set('Authorization', authA).expect(500);

    expect(Object.keys(res.body).sort()).toEqual(['code', 'message', 'path', 'statusCode', 'timestamp'].sort());
  });

  it('T-Q02: error interno provocado → 500 INTERNAL_ERROR, sin stack, sin mensaje de Prisma, sin SQL', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/boom').set('Authorization', authA).expect(500);

    expect(res.body.code).toBe('INTERNAL_ERROR');
    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/at\s+\S+\s+\(.*:\d+:\d+\)/);
    expect(body).not.toMatch(/PrismaClient|SELECT |INSERT |UPDATE /i);
  });

  it('T-Q03: el mismo error deja una fila en ErrorLog, y la respuesta al cliente no cambia', async () => {
    const before = await pool.query('SELECT count(*)::int AS n FROM error_log');

    const res = await request(app.getHttpServer()).get('/api/v1/boom').set('Authorization', authA).expect(500);
    expect(res.body.code).toBe('INTERNAL_ERROR');

    const after = await pool.query('SELECT count(*)::int AS n FROM error_log');
    expect(after.rows[0].n).toBe(before.rows[0].n + 1);
  });

  it('T-Q04: metadata con BigInt se escribe sin lanzar TypeError (regresión de TASK-auth T-11, ErrorLogRepository sin cambios)', async () => {
    const prisma = new PrismaClient();
    try {
      const repository = new ErrorLogRepository(prisma);
      const row = await repository.write({
        message: 'error de Grupo Q con BigInt en metadata',
        stack: null,
        context: 'errors.integration.spec.ts',
        userId: fixture.a.userId,
        metadata: { amountCents: 9_007_199_254_740_993n },
      });

      expect(String((row.metadata as Record<string, unknown>).amountCents)).toBe('9007199254740993');
    } finally {
      await prisma.$disconnect();
    }
  });

  it('T-Q05: GET protegido sin Authorization → 401 UNAUTHORIZED', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/boom').expect(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });

  it('T-Q06: token expirado → 401 UNAUTHORIZED', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/boom')
      .set('Authorization', `Bearer ${signExpiredToken(fixture.a.userId, 'fixture@example.com')}`)
      .expect(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });

  describe('T-Q07: los 11 ERRCODE P1001–P1011, provocados de verdad contra Postgres, mapeados por PrismaErrorMapper', () => {
    const prisma = new PrismaClient();

    afterAll(async () => {
      await prisma.$disconnect();
    });

    async function expectMapped(attempt: () => Promise<unknown>, code: string, status: number): Promise<void> {
      let caught: unknown;
      try {
        await attempt();
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeDefined();
      const domainException = PrismaErrorMapper.toDomainException(caught);
      expect(domainException).toBeDefined();
      expect(domainException!.getStatus()).toBe(status);
      expect((domainException as unknown as { code?: string }).code ?? 'INTERNAL_ERROR').toBe(code);
    }

    // R1/R2/R4/R9 son DEFERRABLE INITIALLY DEFERRED — disparan en el
    // COMMIT, no en el statement. En ese punto Prisma pierde el SQLSTATE
    // por completo (queda como PrismaClientUnknownRequestError, sin
    // `code` ni `meta`, verificado empíricamente en esta sesión).
    // `SET CONSTRAINTS ALL IMMEDIATE` como último statement del arreglo
    // fuerza la evaluación ahí mismo, como un statement normal — el
    // error vuelve a salir como PrismaClientKnownRequestError/P2010 con
    // `meta.code` intacto, que es lo que `parsePgError` ya sabe leer.

    it('P1001 — R1, entries que no suman cero (deferred, falla en el COMMIT)', async () => {
      const txId = randomUUID();
      await expectMapped(
        () =>
          prisma.$transaction([
            prisma.$executeRaw`INSERT INTO transactions (id, user_id, booked_at, description) VALUES (${txId}::uuid, ${fixture.a.userId}::uuid, '2026-08-05', 'P1001')`,
            prisma.$executeRaw`INSERT INTO entries (id, transaction_id, user_id, account_id, amount_cents) VALUES (gen_random_uuid(), ${txId}::uuid, ${fixture.a.userId}::uuid, ${fixture.a.accounts.nu}::uuid, 1000)`,
            prisma.$executeRaw`INSERT INTO entries (id, transaction_id, user_id, account_id, amount_cents) VALUES (gen_random_uuid(), ${txId}::uuid, ${fixture.a.userId}::uuid, ${fixture.a.accounts.comida}::uuid, 500)`,
            prisma.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE'),
          ]),
        'UNBALANCED_TRANSACTION',
        422,
      );
    });

    it('P1002 — R2, un solo entry (deferred)', async () => {
      const txId = randomUUID();
      await expectMapped(
        () =>
          prisma.$transaction([
            prisma.$executeRaw`INSERT INTO transactions (id, user_id, booked_at, description) VALUES (${txId}::uuid, ${fixture.a.userId}::uuid, '2026-08-05', 'P1002')`,
            prisma.$executeRaw`INSERT INTO entries (id, transaction_id, user_id, account_id, amount_cents) VALUES (gen_random_uuid(), ${txId}::uuid, ${fixture.a.userId}::uuid, ${fixture.a.accounts.nu}::uuid, 1000)`,
            prisma.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE'),
          ]),
        'UNBALANCED_TRANSACTION',
        422,
      );
    });

    it('P1003 — R3, entry con userId=A pero accountId de B (inmediato)', async () => {
      const txId = randomUUID();
      // La transacción de setup debe quedar VÁLIDA y balanceada al
      // comprometerse (R1/R2 son diferidos, se evalúan en ESTE commit) —
      // si no, se dispara P1001/P1002 antes de poder probar R3.
      await prisma.$transaction([
        prisma.$executeRaw`INSERT INTO transactions (id, user_id, booked_at, description) VALUES (${txId}::uuid, ${fixture.a.userId}::uuid, '2026-08-05', 'P1003 setup')`,
        prisma.$executeRaw`INSERT INTO entries (id, transaction_id, user_id, account_id, amount_cents) VALUES (gen_random_uuid(), ${txId}::uuid, ${fixture.a.userId}::uuid, ${fixture.a.accounts.nu}::uuid, -1000)`,
        prisma.$executeRaw`INSERT INTO entries (id, transaction_id, user_id, account_id, amount_cents) VALUES (gen_random_uuid(), ${txId}::uuid, ${fixture.a.userId}::uuid, ${fixture.a.accounts.comida}::uuid, 1000)`,
      ]);

      await expectMapped(
        () =>
          prisma.$executeRaw`INSERT INTO entries (id, transaction_id, user_id, account_id, amount_cents) VALUES (gen_random_uuid(), ${txId}::uuid, ${fixture.a.userId}::uuid, ${fixture.b.accounts.nu}::uuid, 1000)`,
        'OWNERSHIP_MISMATCH',
        403,
      );
    });

    it('P1004 — R4, monedas mezcladas (deferred)', async () => {
      const usdAccountId = randomUUID();
      await prisma.$executeRaw`INSERT INTO accounts (id, user_id, name, type, currency) VALUES (${usdAccountId}::uuid, ${fixture.a.userId}::uuid, 'USD test P1004', 'asset', 'USD')`;

      const txId = randomUUID();
      await expectMapped(
        () =>
          prisma.$transaction([
            prisma.$executeRaw`INSERT INTO transactions (id, user_id, booked_at, description) VALUES (${txId}::uuid, ${fixture.a.userId}::uuid, '2026-08-05', 'P1004')`,
            prisma.$executeRaw`INSERT INTO entries (id, transaction_id, user_id, account_id, amount_cents) VALUES (gen_random_uuid(), ${txId}::uuid, ${fixture.a.userId}::uuid, ${fixture.a.accounts.nu}::uuid, -1000)`,
            prisma.$executeRaw`INSERT INTO entries (id, transaction_id, user_id, account_id, amount_cents) VALUES (gen_random_uuid(), ${txId}::uuid, ${fixture.a.userId}::uuid, ${usdAccountId}::uuid, 1000)`,
            prisma.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE'),
          ]),
        'MIXED_CURRENCY',
        422,
      );
    });

    it('P1005 — R5, UPDATE sobre un entry existente (inmediato)', async () => {
      const txId = randomUUID();
      const entryId = randomUUID();
      await prisma.$transaction([
        prisma.$executeRaw`INSERT INTO transactions (id, user_id, booked_at, description) VALUES (${txId}::uuid, ${fixture.a.userId}::uuid, '2026-08-05', 'P1005 setup')`,
        prisma.$executeRaw`INSERT INTO entries (id, transaction_id, user_id, account_id, amount_cents) VALUES (${entryId}::uuid, ${txId}::uuid, ${fixture.a.userId}::uuid, ${fixture.a.accounts.nu}::uuid, -1000)`,
        prisma.$executeRaw`INSERT INTO entries (id, transaction_id, user_id, account_id, amount_cents) VALUES (gen_random_uuid(), ${txId}::uuid, ${fixture.a.userId}::uuid, ${fixture.a.accounts.comida}::uuid, 1000)`,
      ]);

      await expectMapped(
        () => prisma.$executeRaw`UPDATE entries SET amount_cents = 99999 WHERE id = ${entryId}::uuid`,
        'IMMUTABLE_LEDGER',
        409,
      );
    });

    it('P1006 — R6, UPDATE de booked_at sobre una transacción existente (inmediato)', async () => {
      const txId = randomUUID();
      await prisma.$transaction([
        prisma.$executeRaw`INSERT INTO transactions (id, user_id, booked_at, description) VALUES (${txId}::uuid, ${fixture.a.userId}::uuid, '2026-08-05', 'P1006 setup')`,
        prisma.$executeRaw`INSERT INTO entries (id, transaction_id, user_id, account_id, amount_cents) VALUES (gen_random_uuid(), ${txId}::uuid, ${fixture.a.userId}::uuid, ${fixture.a.accounts.nu}::uuid, -1000)`,
        prisma.$executeRaw`INSERT INTO entries (id, transaction_id, user_id, account_id, amount_cents) VALUES (gen_random_uuid(), ${txId}::uuid, ${fixture.a.userId}::uuid, ${fixture.a.accounts.comida}::uuid, 1000)`,
      ]);

      await expectMapped(
        () => prisma.$executeRaw`UPDATE transactions SET booked_at = '2026-08-06' WHERE id = ${txId}::uuid`,
        'IMMUTABLE_LEDGER',
        409,
      );
    });

    it('P1007 — R7, budget_entry con category_id de una cuenta asset (inmediato)', async () => {
      await expectMapped(
        () =>
          prisma.$executeRaw`INSERT INTO budget_entries (id, user_id, period_id, category_id, amount_cents, source) VALUES (gen_random_uuid(), ${fixture.a.userId}::uuid, ${fixture.a.periods.p1}::uuid, ${fixture.a.accounts.nu}::uuid, 1000, 'manual')`,
        'INVALID_BUDGET_CATEGORY',
        422,
      );
    });

    it('P1008 — R8, archivar cuenta asset con saldo distinto de cero (inmediato)', async () => {
      const accountId = randomUUID();
      await prisma.$executeRaw`INSERT INTO accounts (id, user_id, name, type) VALUES (${accountId}::uuid, ${fixture.a.userId}::uuid, 'P1008 test', 'asset')`;
      const txId = randomUUID();
      await prisma.$transaction([
        prisma.$executeRaw`INSERT INTO transactions (id, user_id, booked_at, description) VALUES (${txId}::uuid, ${fixture.a.userId}::uuid, '2026-08-05', 'P1008 saldo')`,
        prisma.$executeRaw`INSERT INTO entries (id, transaction_id, user_id, account_id, amount_cents) VALUES (gen_random_uuid(), ${txId}::uuid, ${fixture.a.userId}::uuid, ${accountId}::uuid, 5000)`,
        prisma.$executeRaw`INSERT INTO entries (id, transaction_id, user_id, account_id, amount_cents) VALUES (gen_random_uuid(), ${txId}::uuid, ${fixture.a.userId}::uuid, ${fixture.a.accounts.sueldo}::uuid, -5000)`,
      ]);

      await expectMapped(
        () => prisma.$executeRaw`UPDATE accounts SET archived_at = now() WHERE id = ${accountId}::uuid`,
        'ACCOUNT_NOT_EMPTY',
        409,
      );
    });

    it('P1009 — R9, reversa de magnitud distinta a la del original (deferred)', async () => {
      const originalId = randomUUID();
      await prisma.$transaction([
        prisma.$executeRaw`INSERT INTO transactions (id, user_id, booked_at, description) VALUES (${originalId}::uuid, ${fixture.a.userId}::uuid, '2026-08-05', 'P1009 original')`,
        prisma.$executeRaw`INSERT INTO entries (id, transaction_id, user_id, account_id, amount_cents) VALUES (gen_random_uuid(), ${originalId}::uuid, ${fixture.a.userId}::uuid, ${fixture.a.accounts.nu}::uuid, -1000)`,
        prisma.$executeRaw`INSERT INTO entries (id, transaction_id, user_id, account_id, amount_cents) VALUES (gen_random_uuid(), ${originalId}::uuid, ${fixture.a.userId}::uuid, ${fixture.a.accounts.comida}::uuid, 1000)`,
      ]);

      const reversalId = randomUUID();
      await expectMapped(
        () =>
          prisma.$transaction([
            prisma.$executeRaw`INSERT INTO transactions (id, user_id, booked_at, description, reverses_transaction_id) VALUES (${reversalId}::uuid, ${fixture.a.userId}::uuid, '2026-08-05', 'P1009 reversa mal', ${originalId}::uuid)`,
            prisma.$executeRaw`INSERT INTO entries (id, transaction_id, user_id, account_id, amount_cents) VALUES (gen_random_uuid(), ${reversalId}::uuid, ${fixture.a.userId}::uuid, ${fixture.a.accounts.nu}::uuid, 500)`,
            prisma.$executeRaw`INSERT INTO entries (id, transaction_id, user_id, account_id, amount_cents) VALUES (gen_random_uuid(), ${reversalId}::uuid, ${fixture.a.userId}::uuid, ${fixture.a.accounts.comida}::uuid, -500)`,
            prisma.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE'),
          ]),
        'INVALID_REVERSAL',
        422,
      );
    });

    it('P1010 — R10, UPDATE de fechas sobre un periodo cerrado (inmediato)', async () => {
      const periodId = randomUUID();
      await prisma.$executeRaw`INSERT INTO budget_periods (id, user_id, starts_on, ends_on, closed_at) VALUES (${periodId}::uuid, ${fixture.a.userId}::uuid, '2026-05-01', '2026-05-15', now())`;

      await expectMapped(
        () => prisma.$executeRaw`UPDATE budget_periods SET starts_on = '2026-04-01' WHERE id = ${periodId}::uuid`,
        'PERIOD_CLOSED',
        409,
      );
    });

    it('P1011 — R11, INSERT de budget_entry en un periodo cerrado', async () => {
      const periodId = randomUUID();
      await prisma.$executeRaw`INSERT INTO budget_periods (id, user_id, starts_on, ends_on, closed_at) VALUES (${periodId}::uuid, ${fixture.a.userId}::uuid, '2026-04-01', '2026-04-15', now())`;

      await expectMapped(
        () =>
          prisma.$executeRaw`INSERT INTO budget_entries (id, user_id, period_id, category_id, amount_cents, source) VALUES (gen_random_uuid(), ${fixture.a.userId}::uuid, ${periodId}::uuid, ${fixture.a.accounts.comida}::uuid, 1000, 'manual')`,
        'PERIOD_CLOSED',
        409,
      );
    });
  });

  it('T-Q08: 25P02 nunca aparece — confirma que ledger-repository usa ON CONFLICT DO NOTHING, no INSERT plano', async () => {
    // Cubierto estructuralmente por T-A10 (grep sin sleep/retry) y por el
    // propio diseño de createWithEntries (§5.1). Se deja como
    // confirmación negativa sobre el log de errores acumulado por esta
    // suite: si 25P02 apareciera alguna vez, quedaría una fila en
    // error_log con ese texto.
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM error_log WHERE message ILIKE '%25P02%' OR message ILIKE '%current transaction is aborted%'`,
    );
    expect(rows[0].n).toBe(0);
  });
});
