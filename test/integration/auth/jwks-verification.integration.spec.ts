import { randomUUID, generateKeyPairSync, createPublicKey } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { createRemoteJWKSet, exportJWK, type JSONWebKeySet } from 'jose';
import { startMockJwksServer, type MockJwksServer } from '../../setup/auth/mock-jwks-server';
import { buildLocalJwks, signValidToken, signTokenWithUnknownKey } from '../../setup/auth/jwt';

// `SupabaseAuthRepository` todavía no acepta un `JwtKeyGetter` de `jose`
// por constructor (hoy lee `SUPABASE_JWT_SECRET` y verifica HS256) — rojo
// por diseño hasta el loop de implementación de la migración a JWKS
// (PROGRESS.md). Mismo patrón que el resto del proyecto: el test se
// escribe contra la forma que va a tener el código, no la que tiene hoy.
import { SupabaseAuthRepository } from '../../../src/auth/repositories/supabase-auth.repository';

/**
 * Prueba `SupabaseAuthRepository` directo contra un JWKS servido por un
 * HTTP local real (`mock-jwks-server.ts`), sin pasar por `AuthGuard` — el
 * comportamiento que se verifica aquí (caché, cooldown, rotación, fallo
 * de red) es de `createRemoteJWKSet`, no del guard. `auth-guard.integration.spec.ts`
 * sigue cubriendo el nivel HTTP con un JWKS local estático
 * (`createLocalJWKSet`), sin red — estos dos archivos son
 * complementarios, no redundantes.
 */
describe('SupabaseAuthRepository — jwks-verification.integration.spec.ts', () => {
  let server: MockJwksServer;

  afterEach(async () => {
    await server?.close();
  });

  it('llave conocida (kid presente en el JWKS) → resuelve userId y email del token', async () => {
    server = await startMockJwksServer(await buildLocalJwks());
    const repository = new SupabaseAuthRepository(createRemoteJWKSet(server.url));

    const userId = randomUUID();
    const token = signValidToken(userId, 'a@example.com');

    await expect(repository.validateToken(token)).resolves.toEqual({ userId, email: 'a@example.com' });
  });

  it('kid que el JWKS nunca publica → rechaza', async () => {
    server = await startMockJwksServer(await buildLocalJwks());
    const repository = new SupabaseAuthRepository(createRemoteJWKSet(server.url));

    const token = signTokenWithUnknownKey(randomUUID(), 'a@example.com');

    await expect(repository.validateToken(token)).rejects.toThrow();
  });

  /**
   * Decisión de Luis: si la descarga del JWKS falla, se falla cerrado —
   * "disponible pero inseguro" es peor que "caído un rato" para el caso
   * que esto protege (revocación de emergencia de una llave). Es el
   * comportamiento por default de `jose` (verificado leyendo su código
   * fuente: sin caché previa, un fetch fallido se propaga tal cual, sin
   * intento de reintento ni de "seguir sin verificar") — cero código
   * propio necesario. Este test es el que deja la decisión fijada en
   * código: si algún día alguien agrega un fallback a caché vieja, este
   * test tiene que cambiar a propósito, no romperse por accidente.
   */
  it('la descarga del JWKS falla (sin caché previa) → rechaza, nunca deja pasar el token', async () => {
    server = await startMockJwksServer(await buildLocalJwks());
    server.setFailing(true);
    const repository = new SupabaseAuthRepository(createRemoteJWKSet(server.url));

    // Primera verificación de todo el proceso: no hay caché, así que
    // CUALQUIER token fuerza un fetch — y el fetch está roto a propósito.
    const token = signValidToken(randomUUID(), 'a@example.com');

    await expect(repository.validateToken(token)).rejects.toThrow();
    expect(server.requestCount()).toBeGreaterThan(0);
  });

  it('cooldown respetado: dos verificaciones seguidas con un kid desconocido no disparan dos fetches', async () => {
    server = await startMockJwksServer(await buildLocalJwks());
    const repository = new SupabaseAuthRepository(createRemoteJWKSet(server.url, { cooldownDuration: 500 }));

    const token = signTokenWithUnknownKey(randomUUID(), 'a@example.com');

    await expect(repository.validateToken(token)).rejects.toThrow();
    expect(server.requestCount()).toBe(1);

    // Segundo intento inmediato, mismo kid desconocido — dentro del
    // cooldown de 500ms: no debe volver a pegarle al servidor. Sin este
    // límite, un `kid` inventado y repetido podría forzar un fetch por
    // cada request.
    await expect(repository.validateToken(token)).rejects.toThrow();
    expect(server.requestCount()).toBe(1);

    // Pasado el cooldown, sí vuelve a intentar — confirma que es un
    // cooldown temporal, no una caché permanente de "kid inválido".
    await new Promise((resolve) => setTimeout(resolve, 600));
    await expect(repository.validateToken(token)).rejects.toThrow();
    expect(server.requestCount()).toBe(2);
  });

  it('rotación: una llave agregada al JWKS después del primer fetch se recoge en el siguiente kid desconocido', async () => {
    server = await startMockJwksServer(await buildLocalJwks());
    const repository = new SupabaseAuthRepository(createRemoteJWKSet(server.url, { cooldownDuration: 0 }));

    // Primer token, con la llave que el servidor ya tenía — puebla la
    // caché de `jose`.
    const firstUserId = randomUUID();
    const firstToken = signValidToken(firstUserId, 'a@example.com');
    await expect(repository.validateToken(firstToken)).resolves.toEqual({ userId: firstUserId, email: 'a@example.com' });
    expect(server.requestCount()).toBe(1);

    // Supabase publica una llave nueva sin retirar la vieja — mismo
    // patrón que "Current key" + "Previous key" del dashboard real
    // durante una rotación en curso.
    const rotatedKid = 'test-rotated-key';
    const { privateKey: rotatedPrivateKey, publicKey: rotatedPublicKey } = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const rotatedJwk = await exportJWK(createPublicKey(rotatedPublicKey));
    const existingJwks = await buildLocalJwks();
    const rotatedJwks: JSONWebKeySet = {
      keys: [...existingJwks.keys, { ...rotatedJwk, kid: rotatedKid, alg: 'ES256', use: 'sig' }],
    };
    server.setJwks(rotatedJwks);

    const secondUserId = randomUUID();
    const secondToken = jwt.sign(
      { sub: secondUserId, email: 'b@example.com', role: 'authenticated', aud: 'authenticated' },
      rotatedPrivateKey,
      { algorithm: 'ES256', keyid: rotatedKid, expiresIn: 3600 },
    );

    // El kid de la llave rotada no estaba en la caché de `jose` →
    // dispara un refetch, la encuentra, valida — sin reiniciar el
    // servidor ni la caché a mano.
    await expect(repository.validateToken(secondToken)).resolves.toEqual({ userId: secondUserId, email: 'b@example.com' });
    expect(server.requestCount()).toBe(2);
  });
});
