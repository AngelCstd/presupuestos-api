import { Module } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { AuthModule } from '../auth/auth.module';
import { AccountsDataModule } from '../shared/accounts-data/accounts-data.module';
import { QueriesModule } from '../shared/queries/queries.module';
import { PeriodsDataModule } from '../shared/periods-data/periods-data.module';
import { PeriodsController } from './periods.controller';
import { PeriodsService } from './periods.service';
import { AllocationsController } from './allocations.controller';
import { AllocationsService } from './allocations.service';
import { PrismaAllocationRepository } from './repositories/prisma-allocation.repository';

/**
 * A08 — el cierre no escribe ledger: sin `LedgerModule` a propósito
 * (§7 de TASK-api.md, "A08 → nada de A07").
 */
@Module({
  imports: [AuthModule, AccountsDataModule, QueriesModule, PeriodsDataModule],
  controllers: [PeriodsController, AllocationsController],
  providers: [
    PeriodsService,
    AllocationsService,
    { provide: 'IAllocationRepository', useClass: PrismaAllocationRepository },
    { provide: PrismaClient, useValue: new PrismaClient() },
  ],
})
export class BudgetModule {}
