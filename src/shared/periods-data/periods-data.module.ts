import { Module } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaBudgetPeriodRepository } from './repositories/prisma-period.repository';

@Module({
  providers: [
    { provide: 'IBudgetPeriodRepository', useClass: PrismaBudgetPeriodRepository },
    { provide: PrismaClient, useValue: new PrismaClient() },
  ],
  exports: ['IBudgetPeriodRepository'],
})
export class PeriodsDataModule {}
