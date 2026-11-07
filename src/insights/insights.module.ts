import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AccountsDataModule } from '../shared/accounts-data/accounts-data.module';
import { QueriesModule } from '../shared/queries/queries.module';
import { PeriodsDataModule } from '../shared/periods-data/periods-data.module';
import { InsightsController } from './insights.controller';
import { InsightsService } from './insights.service';

/**
 * A10 — sin repository propio (D4, §6.10: "insights no calcula nada").
 * Compone F1-F4 vía `QueriesModule` y resuelve el periodo actual vía
 * `PeriodsDataModule`, igual que `BudgetModule` y `RecurringModule`.
 */
@Module({
  imports: [AuthModule, AccountsDataModule, QueriesModule, PeriodsDataModule],
  controllers: [InsightsController],
  providers: [InsightsService],
})
export class InsightsModule {}
