import { INestApplication, Type, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { createLocalJWKSet } from 'jose';
import { GlobalExceptionFilter } from '../../../../src/common/filters/global-exception.filter';
import { ErrorLogRepository } from '../../../../src/common/logging/error-log.repository';
import { ProfileInterceptor } from '../../../../src/common/interceptors/profile.interceptor';
import { EnsureProfileExistsService } from '../../../../src/auth/services/ensure-profile-exists.service';
import { validationExceptionFactory } from '../../../../src/common/validation/validation-exception-factory';
import { buildLocalJwks } from '../../../setup/auth/jwt';

/**
 * Arnés HTTP para test/integration/api/. Deliberadamente mínimo: recibe
 * los módulos de dominio que cada archivo necesita, aplica prefijo,
 * ValidationPipe, el filtro de errores y el interceptor de perfil reales
 * — nada más, sin lógica condicional por tipo de test.
 *
 * NO importa `AppModule`: cuelga de los 7 módulos de dominio (§14 de
 * TASK-api.md), así que el loop 1 no podría compilar hasta que el loop 2
 * también existiera. Cada archivo de test compone su propio arreglo de
 * módulos (p. ej. `createTestApp([ProfileModule])`).
 *
 * El filtro y el interceptor se instancian aquí directamente, no se
 * resuelven por DI de los módulos importados: D4 prohíbe que
 * `AccountsModule`/`CategoriesModule` importen `ProfileModule`, así que
 * nada garantiza que esos módulos registren `GlobalExceptionFilter` o
 * `ProfileInterceptor` como providers propios. `AuthGuard` no se toca
 * aquí a propósito — se aplica por ruta con `@UseGuards()` dentro de cada
 * controller, resuelto por DI en cuanto el módulo importa `AuthModule`.
 *
 * `JwtKeyGetter` sí se sobreescribe: `AuthModule` (real) lo resuelve
 * contra el JWKS remoto de Supabase vía `SUPABASE_URL`; ningún test debe
 * tocar red para verificar un token. Un solo override aquí cubre a los 7
 * módulos de dominio, porque todos importan la misma instancia de
 * `AuthModule` — Nest cachea por clase de módulo, no por sitio de import.
 */
export interface TestAppHandle {
  app: INestApplication;
  moduleRef: TestingModule;
  /**
   * Cierra la app Y desconecta el PrismaClient que este helper crea
   * internamente para el filtro/interceptor. Ese `prisma` nunca se
   * devuelve suelto a propósito — una sola forma de cerrar, para que
   * ningún archivo de test pueda cerrar la mitad y dejar la conexión
   * abierta. Todo archivo que llame `createTestApp` debe llamar
   * `handle.close()` en su `afterAll`, nunca `app.close()` solo.
   */
  close: () => Promise<void>;
}

export async function createTestApp(modules: Array<Type<unknown>>): Promise<TestAppHandle> {
  const moduleRef = await Test.createTestingModule({ imports: modules })
    .overrideProvider('JwtKeyGetter')
    .useFactory({ factory: async () => createLocalJWKSet(await buildLocalJwks()) })
    .compile();

  const prisma = new PrismaClient();
  const app = moduleRef.createNestApplication();

  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      exceptionFactory: validationExceptionFactory,
    }),
  );
  app.useGlobalFilters(new GlobalExceptionFilter(new ErrorLogRepository(prisma)));
  app.useGlobalInterceptors(new ProfileInterceptor(new EnsureProfileExistsService(prisma)));

  await app.init();

  const close = async (): Promise<void> => {
    await app.close();
    await prisma.$disconnect();
  };

  return { app, moduleRef, close };
}
