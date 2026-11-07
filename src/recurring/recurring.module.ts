import { Module } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { AuthModule } from '../auth/auth.module';
import { AccountsDataModule } from '../shared/accounts-data/accounts-data.module';
import { QueriesModule } from '../shared/queries/queries.module';
import { LedgerModule } from '../shared/ledger/ledger.module';
import { PeriodsDataModule } from '../shared/periods-data/periods-data.module';
import { RecurringController } from './recurring.controller';
import { RecurringService } from './recurring.service';
import { PrismaRecurringTemplateRepository } from './repositories/prisma-recurring-template.repository';

/**
 * A09 — `confirm` reusa `buildExpenseEntries`/`nextDueOn`/
 * `createWithEntries` vía `LedgerModule`, nunca importa
 * `TransactionsModule` (D4, §7 de TASK-api.md: "A09 después de A07... no
 * por dependencia de código").
 */
@Module({
  imports: [AuthModule, AccountsDataModule, QueriesModule, LedgerModule, PeriodsDataModule],
  controllers: [RecurringController],
  providers: [
    RecurringService,
    { provide: 'IRecurringTemplateRepository', useClass: PrismaRecurringTemplateRepository },
    { provide: PrismaClient, useValue: new PrismaClient() },
  ],
})
export class RecurringModule {}
