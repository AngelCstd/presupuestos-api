require('../dist/common/bootstrap/bigint-json-override');

const { ValidationPipe } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { ExpressAdapter } = require('@nestjs/platform-express');
const { PrismaClient } = require('@prisma/client');
const express = require('express');
const { AppModule } = require('../dist/app.module');
const { GlobalExceptionFilter } = require('../dist/common/filters/global-exception.filter');
const { ErrorLogRepository } = require('../dist/common/logging/error-log.repository');
const { ProfileInterceptor } = require('../dist/common/interceptors/profile.interceptor');
const { EnsureProfileExistsService } = require('../dist/auth/services/ensure-profile-exists.service');
const { validationExceptionFactory } = require('../dist/common/validation/validation-exception-factory');

const server = express();
let isInitialized = false;

async function bootstrap() {
  if (!isInitialized) {
    const app = await NestFactory.create(AppModule, new ExpressAdapter(server));
    const prisma = new PrismaClient();

    app.setGlobalPrefix('api/v1');
    app.enableCors();
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
    isInitialized = true;
  }
  return server;
}

module.exports = async function handler(req, res) {
  try {
    await bootstrap();
    server(req, res);
  } catch (err) {
    console.error('Serverless execution error:', err);
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        statusCode: 500,
        code: 'INTERNAL_ERROR',
        message: err.message,
      }),
    );
  }
};
