import 'reflect-metadata';
import {
  Body,
  Controller,
  INestApplication,
  Module,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import { IsOptional, IsString } from 'class-validator';
import type { Request } from 'express';
import { PrismaClient } from '@prisma/client';

// Arnés de prueba SOLO para ejercer AuthGuard / GlobalExceptionFilter /
// ValidationPipe de punta a punta por HTTP. Deliberadamente mínimo (dos
// endpoints, nada más) — CLAUDE.md dice "no tocar src/apps/web", y este
// controller NO es parte de la app real: vive en test/setup/auth/, nunca
// se copia a src/. Si crece, es una señal de que se está probando algo que
// pertenece a otro archivo.
//
// Importa símbolos de src/auth/... y src/common/... que todavía no existen
// — el módulo falla al compilar/requerir hasta que el loop de
// implementación los cree (mismo patrón "rojo por diseño" que
// test/integration/m-bigint.spec.ts).
import { createLocalJWKSet } from 'jose';
import { AuthGuard } from '../../../src/auth/guards/auth.guard';
import { SupabaseAuthRepository } from '../../../src/auth/repositories/supabase-auth.repository';
import { GlobalExceptionFilter } from '../../../src/common/filters/global-exception.filter';
import { ErrorLogRepository } from '../../../src/common/logging/error-log.repository';
import { buildLocalJwks } from './jwt';

class ProtectedActionDto {
  @IsString()
  someField!: string;

  // Presente a propósito (T-9): permite mandar un userId de otro usuario
  // en el body sin disparar `forbidNonWhitelisted` — lo que T-9 verifica es
  // que el handler lo IGNORE, no que el campo esté prohibido. T-13 prueba
  // el rechazo con un campo NO declarado aquí.
  @IsOptional()
  @IsString()
  userId?: string;
}

export const handlerCallCounts = { protectedAction: 0, boom: 0 };

export function resetHandlerCallCounts(): void {
  handlerCallCounts.protectedAction = 0;
  handlerCallCounts.boom = 0;
}

interface AuthedRequest extends Request {
  user: { userId: string; email: string };
}

@Controller()
class AuthTestController {
  @Post('protected')
  @UseGuards(AuthGuard)
  protectedAction(@Req() req: AuthedRequest, @Body() _body: ProtectedActionDto) {
    handlerCallCounts.protectedAction += 1;
    // T-9: la respuesta usa el userId del token (req.user), nunca el del
    // body, aunque el DTO lo acepte.
    return { userId: req.user.userId };
  }

  @Post('protected/boom')
  @UseGuards(AuthGuard)
  boom(@Req() _req: AuthedRequest) {
    handlerCallCounts.boom += 1;
    throw new Error('boom: excepción no controlada de una capa interna');
  }
}

@Module({
  controllers: [AuthTestController],
  providers: [
    { provide: 'IAuthRepository', useClass: SupabaseAuthRepository },
    // JWKS local, sin red — Supabase migró a llaves de firma asimétricas
    // (verificado con Luis, PROGRESS.md); en test se usa el mismo par de
    // llaves EC que firma los tokens de `jwt.ts`, nunca la red real.
    { provide: 'JwtKeyGetter', useFactory: async () => createLocalJWKSet(await buildLocalJwks()) },
    // `useValue`, no `useClass`: PrismaClient no está decorado con
    // @Injectable() (viene generado, no es código nuestro) y su
    // constructor acepta un parámetro de opciones que Nest intentaría
    // resolver por DI si dejáramos que lo instancie él mismo.
    { provide: PrismaClient, useValue: new PrismaClient() },
    ErrorLogRepository,
    GlobalExceptionFilter,
  ],
})
class AuthTestModule {}

export interface TestAppHandle {
  app: INestApplication;
  errorLogRepository: ErrorLogRepository;
}

/**
 * Levanta la app de prueba. `overrideErrorLogRepository`, si se pasa,
 * reemplaza el provider real (usado por T-10: el mock que lanza excepción
 * en el insert vive por DI, no mockeando la conexión de Postgres).
 */
export async function createTestApp(overrideErrorLogRepository?: object): Promise<TestAppHandle> {
  const builder = Test.createTestingModule({ imports: [AuthTestModule] });

  const moduleRef = overrideErrorLogRepository
    ? await builder
        .overrideProvider(ErrorLogRepository)
        .useValue(overrideErrorLogRepository)
        .compile()
    : await builder.compile();

  const app = moduleRef.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(moduleRef.get(GlobalExceptionFilter));
  await app.init();

  resetHandlerCallCounts();

  return { app, errorLogRepository: moduleRef.get(ErrorLogRepository) };
}
