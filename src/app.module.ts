import { Module } from '@nestjs/common';
import { ProfileModule } from './profile/profile.module';
import { AccountsModule } from './accounts/accounts.module';
import { CategoriesModule } from './categories/categories.module';
import { TransactionsModule } from './transactions/transactions.module';
import { BudgetModule } from './budget/budget.module';
import { RecurringModule } from './recurring/recurring.module';
import { InsightsModule } from './insights/insights.module';
import { AccountsDataModule } from './shared/accounts-data/accounts-data.module';
import { QueriesModule } from './shared/queries/queries.module';
import { LedgerModule } from './shared/ledger/ledger.module';
import { PeriodsDataModule } from './shared/periods-data/periods-data.module';

/**
 * TASK-api.md §13/§14 — los 7 módulos de dominio más la infraestructura
 * compartida. Cada módulo de dominio ya importa internamente lo que
 * necesita (D4) — importarlos aquí también no duplica providers (Nest
 * cachea por clase de módulo), pero deja explícito en un solo lugar cuál
 * es la superficie completa de la aplicación real, la misma que compone
 * `contract-fixtures.integration.spec.ts` (A11) en el arnés de test.
 */
@Module({
  imports: [
    ProfileModule,
    AccountsModule,
    CategoriesModule,
    TransactionsModule,
    BudgetModule,
    RecurringModule,
    InsightsModule,
    AccountsDataModule,
    QueriesModule,
    LedgerModule,
    PeriodsDataModule,
  ],
})
export class AppModule {}
