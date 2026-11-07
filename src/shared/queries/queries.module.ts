import { Module } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaQueryRepository } from './repositories/prisma-query.repository';

@Module({
  providers: [
    { provide: 'IQueryRepository', useClass: PrismaQueryRepository },
    { provide: PrismaClient, useValue: new PrismaClient() },
  ],
  exports: ['IQueryRepository'],
})
export class QueriesModule {}
