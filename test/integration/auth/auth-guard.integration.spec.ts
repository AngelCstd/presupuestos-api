import { randomUUID } from 'node:crypto';
import request from 'supertest';
import {
  createTestApp,
  handlerCallCounts,
  type TestAppHandle,
} from '../../setup/auth/test-app';
import {
  MALFORMED_TOKEN,
  signExpiredToken,
  signTokenWithUnknownKey,
  signValidToken,
} from '../../setup/auth/jwt';

// Mensajes de error que ninguna respuesta 401 debe filtrar — ni el nombre
// de la librería de verificación anterior (jsonwebtoken, HS256) ni el de
// la actual (jose, JWKS). Un 401 con mensaje genérico no debe delatar con
// qué mecanismo se verificó el token, mucho menos el motivo exacto.
const INTERNAL_ERROR_NAMES =
  /jsonwebtoken|JsonWebTokenError|jose|JWTExpired|JWTInvalid|JWSSignatureVerificationFailed|JWKSNoMatchingKey|JWKSMultipleMatchingKeys/i;

/**
 * AuthGuard — TASK-auth.md, tabla "Tests requeridos antes de implementar",
 * casos 1, 2, 3, 9. No usa EnsureProfileExists: AuthGuard tiene
 * responsabilidad única (validar token), así que el endpoint de prueba
 * solo depende de él.
 */
describe('AuthGuard — auth-guard.integration.spec.ts', () => {
  let handle: TestAppHandle;

  beforeAll(async () => {
    handle = await createTestApp();
  });

  afterAll(async () => {
    await handle.app.close();
  });

  it('T-1: sin header Authorization → 401, el handler nunca se ejecuta', async () => {
    const before = handlerCallCounts.protectedAction;

    await request(handle.app.getHttpServer())
      .post('/protected')
      .send({ someField: 'x' })
      .expect(401);

    expect(handlerCallCounts.protectedAction).toBe(before);
  });

  it('T-2: JWT malformado/alterado → 401, nunca 500, mensaje genérico', async () => {
    const malformedRes = await request(handle.app.getHttpServer())
      .post('/protected')
      .set('Authorization', `Bearer ${MALFORMED_TOKEN}`)
      .send({ someField: 'x' })
      .expect(401);
    expect(String(malformedRes.body.message ?? '')).not.toMatch(INTERNAL_ERROR_NAMES);

    // Firma inválida: el `kid` del token no resuelve a ninguna llave del
    // JWKS de prueba — equivalente asimétrico de "firmado con un secret
    // distinto" (antes de la migración a JWKS de Supabase).
    const unknownKeyRes = await request(handle.app.getHttpServer())
      .post('/protected')
      .set('Authorization', `Bearer ${signTokenWithUnknownKey(randomUUID(), 'a@example.com')}`)
      .send({ someField: 'x' })
      .expect(401);
    expect(String(unknownKeyRes.body.message ?? '')).not.toMatch(INTERNAL_ERROR_NAMES);
  });

  it('T-3: JWT expirado → 401 con mensaje genérico', async () => {
    const token = signExpiredToken(randomUUID(), 'a@example.com');

    const res = await request(handle.app.getHttpServer())
      .post('/protected')
      .set('Authorization', `Bearer ${token}`)
      .send({ someField: 'x' })
      .expect(401);

    // "Mensaje genérico": no debe filtrar detalles internos como el nombre
    // de la librería de verificación (antes jsonwebtoken/HS256, ahora
    // jose/JWKS) o el motivo exacto de fallo.
    expect(String(res.body.message ?? '')).not.toMatch(INTERNAL_ERROR_NAMES);
  });

  it('T-9: token de A + userId de B en el body → la acción usa el userId de A', async () => {
    const userIdA = randomUUID();
    const userIdB = randomUUID();
    const tokenA = signValidToken(userIdA, 'a@example.com');

    const res = await request(handle.app.getHttpServer())
      .post('/protected')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ someField: 'x', userId: userIdB })
      .expect(201);

    expect(res.body.userId).toBe(userIdA);
    expect(res.body.userId).not.toBe(userIdB);
  });
});
