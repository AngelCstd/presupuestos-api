// test/setup/apply-auth-stub.ts
//
// El stub se expone como función reutilizable — no solo como globalSetup —
// porque `prisma migrate reset` puede eliminar el schema `auth` a media
// suite (T-L03 lo ejecuta). Si eso pasa y el stub solo corriera una vez al
// inicio, todos los tests posteriores fallarían por violación de FK contra
// `auth.users`, con un mensaje que parece bug de la migración de `profiles`
// y no lo es.
//
// Es idempotente: seguro de llamar tantas veces como haga falta.

import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';

export async function applyAuthStub(connectionString?: string): Promise<void> {
  const url =
    connectionString ??
    process.env.TEST_DATABASE_URL ??
    process.env.DATABASE_URL;

  if (!url) {
    throw new Error(
      'applyAuthStub: no hay TEST_DATABASE_URL ni DATABASE_URL definidas.',
    );
  }

  const sql = readFileSync(join(__dirname, 'local-auth-stub.sql'), 'utf-8');
  const client = new Client({ connectionString: url });

  try {
    await client.connect();
    await client.query(sql);
  } finally {
    await client.end();
  }
}
