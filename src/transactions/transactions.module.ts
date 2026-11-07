import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AccountsDataModule } from '../shared/accounts-data/accounts-data.module';
import { QueriesModule } from '../shared/queries/queries.module';
import { LedgerModule } from '../shared/ledger/ledger.module';
import { PeriodsDataModule } from '../shared/periods-data/periods-data.module';
import { TransactionsController } from './transactions.controller';
import { TransactionsService } from './transactions.service';

@Module({
  imports: [AuthModule, AccountsDataModule, QueriesModule, LedgerModule, PeriodsDataModule],
  controllers: [TransactionsController],
  providers: [TransactionsService],
})
export class TransactionsModule {}
