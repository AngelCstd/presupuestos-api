import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import type { ErrorLog, Prisma } from '@prisma/client';
import { sanitizeMetadata } from './error-log-serializer';

export interface WriteErrorLogInput {
  message: string;
  stack: string | null;
  context: string | null;
  userId: string | null;
  metadata: unknown;
}

/**
 * Escritura best-effort en ErrorLog (TASK-auth.md, Entregables). El
 * sanitizado defensivo de `metadata` cubre function/symbol/circular; el
 * override de BigInt.prototype.toJSON (efecto de importar
 * error-log-serializer.ts, que reexporta de src/shared/money) cubre el
 * resto — ver T-11.
 */
@Injectable()
export class ErrorLogRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async write(entry: WriteErrorLogInput): Promise<ErrorLog> {
    return this.prisma.errorLog.create({
      data: {
        message: entry.message,
        stack: entry.stack,
        context: entry.context,
        userId: entry.userId,
        metadata: sanitizeMetadata(entry.metadata) as Prisma.InputJsonValue,
      },
    });
  }
}
