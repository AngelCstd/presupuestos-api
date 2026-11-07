import { generateKeyPairSync, createPublicKey } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { exportJWK, type JSONWebKeySet } from 'jose';

/**
 * Claims mínimos que `SupabaseAuthRepository.validateToken()` debe poder
 * mapear a `{ userId, email }` (interfaz literal de TASK-auth.md). `sub`
 * como userId y `email` como email es la convención estándar de Supabase
 * Auth — inferido, no documentado literalmente; ajustar si el loop de
 * implementación lee otros claims.
 *
 * Supabase migró de un JWT Secret compartido (HS256) a llaves de firma
 * asimétricas (JWKS) — verificado en el dashboard real de Luis, ver
 * PROGRESS.md. Los tokens de prueba se firman con una llave EC (ES256)
 * generada localmente al cargar este módulo, nunca con un secret de
 * `.env.test` — no hace falta ninguna variable de entorno para firmar.
 */

const KID = 'test-signing-key-1';
const UNKNOWN_KID = 'test-signing-key-not-in-jwks';

const { privateKey, publicKey } = generateKeyPairSync('ec', {
  namedCurve: 'P-256',
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

// Segunda llave, deliberadamente NUNCA agregada al JWKS que expone
// `buildLocalJwks()` — es lo que antes hacía "firmado con un secret
// distinto" (HS256) para probar firma inválida; con llaves asimétricas
// el equivalente es "firmado con una llave que el verificador no conoce".
const { privateKey: unknownPrivateKey } = generateKeyPairSync('ec', {
  namedCurve: 'P-256',
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

export function signValidToken(userId: string, email: string, expiresInSeconds = 3600): string {
  return jwt.sign({ sub: userId, email, role: 'authenticated', aud: 'authenticated' }, privateKey, {
    algorithm: 'ES256',
    keyid: KID,
    expiresIn: expiresInSeconds,
  });
}

export function signExpiredToken(userId: string, email: string): string {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    { sub: userId, email, role: 'authenticated', aud: 'authenticated', iat: now - 7200, exp: now - 3600 },
    privateKey,
    { algorithm: 'ES256', keyid: KID },
  );
}

/**
 * Firmado con una llave EC que el JWKS de prueba nunca publica — firma
 * inválida (el `kid` no resuelve a ninguna llave conocida), no forma
 * inválida. Reemplaza al antiguo `signTokenWithWrongSecret` (HS256):
 * mismo caso de prueba, mecanismo distinto porque el modelo de llaves
 * cambió, no la intención del test.
 */
export function signTokenWithUnknownKey(userId: string, email: string): string {
  return jwt.sign({ sub: userId, email, role: 'authenticated', aud: 'authenticated' }, unknownPrivateKey, {
    algorithm: 'ES256',
    keyid: UNKNOWN_KID,
    expiresIn: 3600,
  });
}

/** No es un JWT en absoluto — cubre "malformado", distinto de "alterado". */
export const MALFORMED_TOKEN = 'esto-no-es-un-jwt';

let cachedJwks: JSONWebKeySet | null = null;

/**
 * El JWKS que expone el par de llaves "oficial" de prueba (`KID`) — lo
 * usa el arnés de test para construir un `JWTVerifyGetKey` local
 * (`jose.createLocalJWKSet`) sin tocar red. Nunca incluye la llave de
 * `signTokenWithUnknownKey`. Memoizado: `exportJWK` es async pero la
 * llave no cambia entre llamadas dentro del mismo proceso de test.
 */
export async function buildLocalJwks(): Promise<JSONWebKeySet> {
  if (cachedJwks) return cachedJwks;
  const jwk = await exportJWK(createPublicKey(publicKey));
  cachedJwks = { keys: [{ ...jwk, kid: KID, alg: 'ES256', use: 'sig' }] };
  return cachedJwks;
}

/** Exportado para que `mock-jwks-server.ts` pueda simular una rotación agregando una segunda llave real. */
export function getTestSigningMaterial() {
  return { KID, UNKNOWN_KID, privateKey, publicKey };
}
