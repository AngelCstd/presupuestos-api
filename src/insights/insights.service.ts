import { Inject, Injectable } from '@nestjs/common';
import { AccountType } from '@prisma/client';
import type { IAccountRepository } from '../shared/accounts-data/interfaces/account-repository.interface';
import type { IQueryRepository } from '../shared/queries/interfaces/query-repository.interface';
import type { IBudgetPeriodRepository } from '../shared/periods-data/interfaces/period-repository.interface';
import { todayInTimezone } from '../shared/time/today-in-timezone';
import { PeriodNotFoundException } from '../shared/periods-data/exceptions/period-not-found.exception';
import { AccountBalancesResponseDto, type AccountBalanceEntry } from './dto/account-balances-response.dto';
import { CategoryBalancesResponseDto } from './dto/category-balances-response.dto';
import { UnassignedFundsResponseDto } from './dto/unassigned-funds-response.dto';
import { UnbudgetedTransactionsResponseDto } from './dto/unbudgeted-transactions-response.dto';
import { DashboardResponseDto } from './dto/dashboard-response.dto';

// Todos los tipos direccionables por el usuario, excepto `Equity` — el
// ancla de sistema nunca se muestra (§3.2, §6.10).
const ALL_ADDRESSABLE_TYPES = [AccountType.Asset, AccountType.Liability, AccountType.Receivable, AccountType.Expense, AccountType.Income];
// `account-balances` no pagina (§6.10) — un usuario personal nunca tiene
// tantas cuentas como para que esto importe.
const ALL_ACCOUNTS_PAGE = { page: 1, pageSize: 100_000 };

@Injectable()
export class InsightsService {
  constructor(
    @Inject('IAccountRepository') private readonly accountRepository: IAccountRepository,
    @Inject('IQueryRepository') private readonly queryRepository: IQueryRepository,
    @Inject('IBudgetPeriodRepository') private readonly periodRepository: IBudgetPeriodRepository,
  ) {}

  async accountBalances(userId: string): Promise<AccountBalancesResponseDto> {
    const { accounts, balanceByAccount } = await this.loadAccountBalances(userId);
    return AccountBalancesResponseDto.from(accounts, balanceByAccount);
  }

  async categoryBalances(userId: string, periodId: string): Promise<CategoryBalancesResponseDto> {
    await this.getPeriodOrThrow(userId, periodId);
    const rows = await this.queryRepository.categoryBalances(userId, periodId);
    return CategoryBalancesResponseDto.from(periodId, rows);
  }

  async unassignedFunds(userId: string): Promise<UnassignedFundsResponseDto> {
    const unassignedCents = await this.queryRepository.unassignedFunds(userId);
    return UnassignedFundsResponseDto.from(unassignedCents);
  }

  async unbudgetedTransactions(userId: string): Promise<UnbudgetedTransactionsResponseDto> {
    const rows = await this.queryRepository.transactionsWithoutPeriod(userId);
    return UnbudgetedTransactionsResponseDto.from(rows);
  }

  async dashboard(userId: string, timezone: string, periodId?: string): Promise<DashboardResponseDto> {
    // `periodId` explícito e inválido → 404 (sin cambios). Sin
    // `periodId` y sin periodo que cubra hoy → NO es un error: es el
    // estado de un usuario recién creado (API-CONTRACT.md §14, línea
    // 1340 — "period y categories vienen en null y [] si no hay
    // periodo actual ni periodId"). El resto del dashboard no depende
    // de que exista un periodo.
    const period = periodId ? await this.getPeriodOrThrow(userId, periodId) : await this.getCurrentPeriodCovering(userId, timezone);

    const [{ accounts, balanceByAccount }, unassignedCents, categoryRows, unbudgetedRows] = await Promise.all([
      this.loadAccountBalances(userId),
      this.queryRepository.unassignedFunds(userId),
      period ? this.queryRepository.categoryBalances(userId, period.id) : Promise.resolve([]),
      this.queryRepository.transactionsWithoutPeriod(userId),
    ]);

    const accountEntries: AccountBalanceEntry[] = AccountBalancesResponseDto.from(accounts, balanceByAccount).accounts;
    const categoryEntries = period ? CategoryBalancesResponseDto.from(period.id, categoryRows).categories : [];
    const unbudgetedEntries = UnbudgetedTransactionsResponseDto.from(unbudgetedRows).transactions;

    return DashboardResponseDto.from(accountEntries, unassignedCents, period, categoryEntries, unbudgetedEntries);
  }

  private async loadAccountBalances(userId: string) {
    const [page, balances] = await Promise.all([
      this.accountRepository.findMany(userId, { types: ALL_ADDRESSABLE_TYPES, includeArchived: true, includeSystem: false }, ALL_ACCOUNTS_PAGE),
      this.queryRepository.accountBalances(userId),
    ]);
    const balanceByAccount = new Map(balances.map((b) => [b.accountId, b.balanceCents]));
    return { accounts: page.data, balanceByAccount };
  }

  private async getPeriodOrThrow(userId: string, periodId: string) {
    const period = await this.periodRepository.findById(userId, periodId);
    if (!period) {
      throw new PeriodNotFoundException();
    }
    return period;
  }

  private async getCurrentPeriodCovering(userId: string, timezone: string) {
    const today = todayInTimezone(timezone);
    return this.periodRepository.findPeriodCoveringDate(userId, today);
  }
}
