import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { createTestApp, type TestAppHandle } from '../../setup/auth/test-app';
import { signValidToken } from '../../setup/auth/jwt';

// `ErrorLogRepository` (TASK-auth.md, Entregables: modelo Prisma ErrorLog
// con message/stack/context/userId/metadata/createdAt) no tiene un método
// público documentado literalmente — se infiere `write(entry): Promise<Row>`
// devolviendo la fila insertada (mismo patrón RETURNING que
// EnsureProfileExists), para poder verificar T-11 sin inventar el nombre
// de la tabla física. Ajustar si el loop la nombra distinto.
import { ErrorLogRepository } from '../../../src/common/logging/error-log.repository';

describe('GlobalExceptionFilter / ErrorLog — error-log-serializer.integration.spec.ts', () => {
  it('T-12: excepción no controlada → 500 genérico, sin stack trace en la respuesta', async () => {
    const handle = await createTestApp();
    const token = signValidToken(randomUUID(), 'a@example.com');
    try {
      const res = await request(handle.app.getHttpServer())
        .post('/protected/boom')
        .set('Authorization', `Bearer ${token}`)
        .send({})
        .expect(500);

      const body = JSON.stringify(res.body);
      expect(body).not.toMatch(/at\s+\S+\s+\(.*:\d+:\d+\)/); // patrón de línea de stack trace
      expect(body).not.toContain(__filename);
    } finally {
      await handle.app.close();
    }
  });

  it('T-10: fallo al escribir ErrorLog (mock por DI) → la respuesta al cliente no se ve afectada', async () => {
    const failingRepository = {
      write: async () => {
        throw new Error('insert al ErrorLog falló — simulado');
      },
    };
    const handle = await createTestApp(failingRepository);
    const token = signValidToken(randomUUID(), 'a@example.com');
    try {
      // Mismo 500 genérico que T-12 — el fallo del logging es best-effort,
      // nunca debe convertirse en un error distinto ni colgar el request.
      await request(handle.app.getHttpServer())
        .post('/protected/boom')
        .set('Authorization', `Bearer ${token}`)
        .send({})
        .expect(500);
    } finally {
      await handle.app.close();
    }
  });

  it('T-11: metadata con BigInt se escribe sin lanzar, con valor legible', async () => {
    const prisma = new PrismaClient();
    const repository = new ErrorLogRepository(prisma);
    try {
      const hugeValue = 9_007_199_254_740_993n;

      const row = await repository.write({
        message: 'error de prueba con BigInt en metadata',
        stack: null,
        context: 'error-log-serializer.integration.spec.ts',
        userId: null,
        metadata: { amountCents: hugeValue },
      });

      expect(row.metadata).toBeDefined();
      // Serializado como string legible (ARCHITECTURE.md §3.11/§4) — nunca
      // lanza aunque el valor no sea JSON-serializable de forma nativa.
      expect(String((row.metadata as Record<string, unknown>).amountCents)).toBe(hugeValue.toString());
    } finally {
      await prisma.$disconnect();
    }
  });
});
