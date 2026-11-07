import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AccountsDataModule } from '../shared/accounts-data/accounts-data.module';
import { QueriesModule } from '../shared/queries/queries.module';
import { LedgerModule } from '../shared/ledger/ledger.module';
import { CategoriesController } from './categories.controller';
import { IncomeSourcesController } from './income-sources.controller';
import { CategoriesService } from './categories.service';
import { IncomeSourcesService } from './income-sources.service';

@Module({
  imports: [AuthModule, AccountsDataModule, QueriesModule, LedgerModule],
  controllers: [CategoriesController, IncomeSourcesController],
  providers: [CategoriesService, IncomeSourcesService],
})
export class CategoriesModule {}
