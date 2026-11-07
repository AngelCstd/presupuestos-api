import { Prisma } from '@prisma/client';

/**
 * TASK-api.md §5.4 — extrae SQLSTATE y nombre de constraint de un error
 * crudo de Postgres, llegado vía `$queryRaw`/`$executeRaw` como
 * `PrismaClientKnownRequestError` con `code === 'P2010'`. El SQLSTATE
 * real vive en `meta.code`; el nombre de constraint se extrae del texto
 * de `meta.message` (Postgres no lo expone como campo estructurado
 * aparte). Discrimina por nombre, nunca por el texto semántico completo
 * del mensaje (§6 de TASK-db.md).
 */
export function parsePgError(e: unknown): { sqlstate: string; constraint: string | null } | null {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== 'P2010') {
    return null;
  }

  const meta = e.meta as { code?: string; message?: string } | undefined;
  const sqlstate = meta?.code;
  if (!sqlstate) {
    return null;
  }

  const match = (meta?.message ?? '').match(/constraint "([^"]+)"/);
  return { sqlstate, constraint: match ? match[1] : null };
}
