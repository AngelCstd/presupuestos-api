import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AccountsDataModule } from '../shared/accounts-data/accounts-data.module';
import { QueriesModule } from '../shared/queries/queries.module';
import { LedgerModule } from '../shared/ledger/ledger.module';
import { AccountsController } from './accounts.controller';
import { AccountsService } from './accounts.service';

@Module({
  imports: [AuthModule, AccountsDataModule, QueriesModule, LedgerModule],
  controllers: [AccountsController],
  providers: [AccountsService],
})
export class AccountsModule {}
