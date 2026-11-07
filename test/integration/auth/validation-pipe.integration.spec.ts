import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createTestApp, type TestAppHandle } from '../../setup/auth/test-app';
import { signValidToken } from '../../setup/auth/jwt';

/**
 * ValidationPipe global — TASK-auth.md, caso 13. `whitelist` +
 * `forbidNonWhitelisted` se registran en el arnés de prueba
 * (test/setup/auth/test-app.ts) exactamente como se documentan como
 * entregable — no hay pipe custom de src/ que importar aquí.
 */
describe('ValidationPipe — validation-pipe.integration.spec.ts', () => {
  let handle: TestAppHandle;
  let token: string;

  beforeAll(async () => {
    handle = await createTestApp();
    token = signValidToken(randomUUID(), 'a@example.com');
  });

  afterAll(async () => {
    await handle.app.close();
  });

  it('T-13: DTO con propiedad no declarada → 400', async () => {
    await request(handle.app.getHttpServer())
      .post('/protected')
      .set('Authorization', `Bearer ${token}`)
      .send({ someField: 'x', unDeclaredField: 'y' })
      .expect(400);
  });

  it('T-13 (control): el mismo DTO sin campos extra sí pasa', async () => {
    await request(handle.app.getHttpServer())
      .post('/protected')
      .set('Authorization', `Bearer ${token}`)
      .send({ someField: 'x' })
      .expect(201);
  });
});
