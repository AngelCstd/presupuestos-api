import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { JSONWebKeySet } from 'jose';

/**
 * Servidor HTTP local mínimo que sirve un JWKS mutable — para probar
 * `createRemoteJWKSet` (caché, cooldown, rotación, fallo de red) sin
 * tocar la red real ni depender de que Supabase esté disponible durante
 * los tests. Puerto efímero, cierra limpio con `close()`.
 */
export interface MockJwksServer {
  url: URL;
  requestCount: () => number;
  setJwks: (jwks: JSONWebKeySet) => void;
  /** `true` → cada request rompe la conexión (simula fallo de red/timeout, no un 4xx/5xx controlado). */
  setFailing: (failing: boolean) => void;
  close: () => Promise<void>;
}

export async function startMockJwksServer(initialJwks: JSONWebKeySet): Promise<MockJwksServer> {
  let current = initialJwks;
  let failing = false;
  let count = 0;

  const server: Server = createServer((_req, res) => {
    count += 1;
    if (failing) {
      // Corta la conexión sin responder — un 500 controlado seguiría
      // siendo una respuesta válida que `fetch` podría parsear; lo que
      // hay que simular es la descarga fallando de plano.
      res.destroy();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(current));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: new URL(`http://127.0.0.1:${port}/jwks`),
    requestCount: () => count,
    setJwks: (jwks) => {
      current = jwks;
    },
    setFailing: (value) => {
      failing = value;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
