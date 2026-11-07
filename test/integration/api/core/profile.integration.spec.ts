import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { createTestApp, type TestAppHandle } from '../_helpers/app';
import { bearerFor } from '../_helpers/auth';
import { pool, seedFixtureCommitted, type Fixture } from '../_helpers/seed';

// Grupo P — perfil (TASK-api.md §11, T-P01–P06). ProfileModule no existe
// todavía — rojo por diseño.
import { ProfileModule } from '../../../../src/profile/profile.module';

describe('ProfileModule — profile.integration.spec.ts (Grupo P)', () => {
  let app: INestApplication;
  let handle: TestAppHandle;
  let fixture: Fixture;
  let authA: string;

  beforeAll(async () => {
    fixture = await seedFixtureCommitted();
    authA = bearerFor(fixture.a.userId);

    handle = await createTestApp([ProfileModule]);
    app = handle.app;
  });

  afterAll(async () => {
    await handle.close();
    await pool.end();
  });

  it('T-P01: GET /me con un usuario ya sembrado → 200, timezone default, userId = sub del JWT', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/me').set('Authorization', authA).expect(200);

    expect(res.body.userId).toBe(fixture.a.userId);
    expect(res.body.timezone).toBe('America/Mexico_City');
  });

  it('T-P02: PATCH /me {timezone:"America/Monterrey"} → 200, persiste', async () => {
    await request(app.getHttpServer())
      .patch('/api/v1/me')
      .set('Authorization', authA)
      .send({ timezone: 'America/Monterrey' })
      .expect(200);

    const res = await request(app.getHttpServer()).get('/api/v1/me').set('Authorization', authA).expect(200);
    expect(res.body.timezone).toBe('America/Monterrey');
  });

  it('T-P03: PATCH /me {timezone:"Marte/Olympus"} → 400 INVALID_TIMEZONE', async () => {
    const res = await request(app.getHttpServer())
      .patch('/api/v1/me')
      .set('Authorization', authA)
      .send({ timezone: 'Marte/Olympus' })
      .expect(400);
    expect(res.body.code).toBe('INVALID_TIMEZONE');
  });

  it('T-P04: PATCH /me {userId:"..."} → 400 VALIDATION_FAILED — el userId nunca viaja en el body', async () => {
    const res = await request(app.getHttpServer())
      .patch('/api/v1/me')
      .set('Authorization', authA)
      .send({ userId: randomUUID() })
      .expect(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
  });

  it('T-P05: primer request autenticado de un usuario sin fila en profiles → el interceptor la crea, responde normal', async () => {
    const newUserId = randomUUID();
    await pool.query('INSERT INTO auth.users (id) VALUES ($1)', [newUserId]);

    const before = await pool.query('SELECT count(*)::int AS n FROM profiles WHERE id = $1', [newUserId]);
    expect(before.rows[0].n).toBe(0);

    const res = await request(app.getHttpServer()).get('/api/v1/me').set('Authorization', bearerFor(newUserId)).expect(200);
    expect(res.body.userId).toBe(newUserId);

    const after = await pool.query('SELECT count(*)::int AS n FROM profiles WHERE id = $1', [newUserId]);
    expect(after.rows[0].n).toBe(1);
  });

  it('T-P06: usuario con deleted_at no nulo → 403 PROFILE_DELETED', async () => {
    const deletedUserId = randomUUID();
    await pool.query('INSERT INTO auth.users (id) VALUES ($1)', [deletedUserId]);
    await pool.query('INSERT INTO profiles (id, deleted_at) VALUES ($1, now())', [deletedUserId]);

    const res = await request(app.getHttpServer()).get('/api/v1/me').set('Authorization', bearerFor(deletedUserId)).expect(403);
    expect(res.body.code).toBe('PROFILE_DELETED');
  });
});
