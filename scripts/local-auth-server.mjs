import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { exportJWK } from 'jose';
import jwt from 'jsonwebtoken';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const keysFile = path.join(rootDir, '.local-auth-keys.json');

if (!fs.existsSync(keysFile)) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  fs.writeFileSync(keysFile, JSON.stringify({ privateKey, publicKey }, null, 2));
}

const { privateKey, publicKey } = JSON.parse(fs.readFileSync(keysFile, 'utf8'));
const KID = 'local-test-key-1';
const pubKeyObj = crypto.createPublicKey(publicKey);
const jwk = await exportJWK(pubKeyObj);
jwk.kid = KID;
jwk.alg = 'ES256';
jwk.use = 'sig';

export function mintToken(userId = 'e68fcf27-7fe4-4944-bb42-0eac5da720a5', email = 'luis@presupuestos.app') {
  return jwt.sign(
    {
      sub: userId,
      email,
      role: 'authenticated',
      aud: 'authenticated',
    },
    privateKey,
    {
      algorithm: 'ES256',
      keyid: KID,
      expiresIn: '30d',
    }
  );
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  
  if (url.pathname === '/auth/v1/.well-known/jwks.json') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify({ keys: [jwk] }));
    return;
  }

  if (url.pathname === '/mint-token') {
    const userId = url.searchParams.get('userId') || 'e68fcf27-7fe4-4944-bb42-0eac5da720a5';
    const email = url.searchParams.get('email') || 'luis@presupuestos.app';
    const token = mintToken(userId, email);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify({ token, userId, email }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const PORT = 54321;
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`Local JWKS Auth Server running on http://127.0.0.1:${PORT}`);
    console.log(`JWKS endpoint: http://127.0.0.1:${PORT}/auth/v1/.well-known/jwks.json`);
  });
}
