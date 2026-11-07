import './common/bootstrap/bigint-json-override';

import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { PrismaClient } from '@prisma/client';
import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import { ErrorLogRepository } from './common/logging/error-log.repository';
import { ProfileInterceptor } from './common/interceptors/profile.interceptor';
import { EnsureProfileExistsService } from './auth/services/ensure-profile-exists.service';
import { validationExceptionFactory } from './common/validation/validation-exception-factory';

/**
 * El filtro y el interceptor se instancian directamente, no se resuelven
 * por DI de los módulos importados: D4 prohíbe que `AccountsModule`/
 * `CategoriesModule` importen `ProfileModule`, así que nada garantiza que
 * esos módulos registren `GlobalExceptionFilter` o `ProfileInterceptor`
 * como providers propios. Mismo patrón que
 * `test/integration/api/_helpers/app.ts` — es el arnés real, no debe
 * divergir del arnés de test.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const prisma = new PrismaClient();

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

  const port = process.env.PORT ? Number(process.env.PORT) : 3000;
  await app.listen(port);
}

bootstrap();
