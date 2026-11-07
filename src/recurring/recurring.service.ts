import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { AccountType } from '@prisma/client';
import type { IAccountRepository } from '../shared/accounts-data/interfaces/account-repository.interface';
import type { ITransactionRepository } from '../shared/ledger/interfaces/transaction-repository.interface';
import type { IBudgetPeriodRepository } from '../shared/periods-data/interfaces/period-repository.interface';
import type { IRecurringTemplateRepository, RecurringTemplateRow } from './interfaces/recurring-template-repository.interface';
import type { Paged } from '../common/pagination/types';
import { buildExpenseEntries } from '../shared/ledger/entry-builders';
import { nextDueOn } from '../shared/recurrence/next-due-on';
import { resolveLateCaptureCompensation } from '../shared/ledger/late-capture';
import { validateAndLoadAccounts } from '../shared/ledger/account-roles';
import { todayInTimezone } from '../shared/time/today-in-timezone';
import { TransactionResponseDto, BudgetImpactDto } from '../shared/ledger/dto/transaction-response.dto';

import { CreateRecurringTemplateDto } from './dto/create-recurring-template.dto';
import { UpdateRecurringTemplateDto } from './dto/update-recurring-template.dto';
import { ConfirmRecurringTemplateDto } from './dto/confirm-recurring-template.dto';
import { ListRecurringTemplatesQueryDto } from './dto/list-recurring-templates.query';
import { RecurringTemplateResponseDto } from './dto/recurring-template-response.dto';
import { RecurringTemplateNotFoundException } from './exceptions/recurring-template-not-found.exception';
import { PaymentAccountRequiredException } from './exceptions/payment-account-required.exception';

const ASSET_LIABILITY = [AccountType.Asset, AccountType.Liability];
const EXPENSE = [AccountType.Expense];

export interface ConfirmResult {
  transaction: TransactionResponseDto;
  template: RecurringTemplateResponseDto;
  created: boolean;
}

@Injectable()
export class RecurringService {
  constructor(
    @Inject('IRecurringTemplateRepository') private readonly templateRepository: IRecurringTemplateRepository,
    @Inject('IAccountRepository') private readonly accountRepository: IAccountRepository,
    @Inject('ITransactionRepository') private readonly transactionRepository: ITransactionRepository,
    @Inject('IBudgetPeriodRepository') private readonly periodRepository: IBudgetPeriodRepository,
  ) {}

  async create(userId: string, timezone: string, dto: CreateRecurringTemplateDto): Promise<RecurringTemplateResponseDto> {
    const specs = [
      { id: dto.categoryId, allowedTypes: EXPENSE },
      ...(dto.accountId ? [{ id: dto.accountId, allowedTypes: ASSET_LIABILITY }] : []),
    ];
    const accounts = await validateAndLoadAccounts(this.accountRepository, userId, specs);

    const today = todayInTimezone(timezone);
    const referenceDate = dto.nextDueOn ? parseDateOnly(dto.nextDueOn) : parseDateOnly(today);
    const computedNextDueOn = dto.nextDueOn ? parseDateOnly(dto.nextDueOn) : nextDueOn(dto.dayOfMonth, referenceDate);

    const row = await this.templateRepository.create(userId, {
      name: dto.name,
      accountId: dto.accountId ?? null,
      categoryId: dto.categoryId,
      amountCents: dto.amountCents,
      dayOfMonth: dto.dayOfMonth,
      nextDueOn: computedNextDueOn,
    });

    return this.toResponseDto(row, accounts, today);
  }

  async findMany(userId: string, timezone: string, query: ListRecurringTemplatesQueryDto): Promise<Paged<RecurringTemplateResponseDto>> {
    const today = todayInTimezone(timezone);
    const page = await this.templateRepository.findMany(
      userId,
      { dueOnly: query.dueOnly, includeInactive: query.includeInactive, today },
      { page: query.page, pageSize: query.pageSize },
    );
    const accounts = await this.loadAccountsFor(userId, page.data);
    return {
      data: page.data.map((row) => this.toResponseDto(row, accounts, today)),
      page: page.page,
      pageSize: page.pageSize,
      total: page.total,
    };
  }

  async findById(userId: string, timezone: string, id: string): Promise<RecurringTemplateResponseDto> {
    const row = await this.getOrThrow(userId, id);
    const today = todayInTimezone(timezone);
    const accounts = await this.loadAccountsFor(userId, [row]);
    return this.toResponseDto(row, accounts, today);
  }

  async update(userId: string, timezone: string, id: string, dto: UpdateRecurringTemplateDto): Promise<RecurringTemplateResponseDto> {
    await this.getOrThrow(userId, id);

    const specs = [
      ...(dto.categoryId ? [{ id: dto.categoryId, allowedTypes: EXPENSE }] : []),
      ...(dto.accountId ? [{ id: dto.accountId, allowedTypes: ASSET_LIABILITY }] : []),
    ];
    if (specs.length > 0) {
      await validateAndLoadAccounts(this.accountRepository, userId, specs);
    }

    const updated = await this.templateRepository.update(userId, id, {
      name: dto.name,
      accountId: dto.accountId,
      categoryId: dto.categoryId,
      amountCents: dto.amountCents,
      dayOfMonth: dto.dayOfMonth,
      isActive: dto.isActive,
    });

    const today = todayInTimezone(timezone);
    const accounts = await this.loadAccountsFor(userId, [updated]);
    return this.toResponseDto(updated, accounts, today);
  }

  async remove(userId: string, id: string): Promise<void> {
    await this.getOrThrow(userId, id);
    await this.templateRepository.softDelete(userId, id);
  }

  async confirm(userId: string, timezone: string, id: string, dto: ConfirmRecurringTemplateDto, idempotencyKey: string): Promise<ConfirmResult> {
    const template = await this.getOrThrow(userId, id);

    const paidFromAccountId = dto.paidFromAccountId ?? template.accountId;
    if (!paidFromAccountId) {
      throw new PaymentAccountRequiredException();
    }

    const specs = [
      { id: paidFromAccountId, allowedTypes: ASSET_LIABILITY },
      { id: template.categoryId, allowedTypes: EXPENSE },
    ];
    const accounts = await validateAndLoadAccounts(this.accountRepository, userId, specs);

    const today = todayInTimezone(timezone);
    const bookedAt = dto.bookedAt ?? today;
    const amountCents = dto.amountCents ?? template.amountCents;
    const description = dto.description ?? template.name;

    const entries = buildExpenseEntries({
      paidFromAccountId,
      lines: [{ categoryId: template.categoryId, amountCents }],
      totalCents: amountCents,
    });

    const categoryIds = new Set([template.categoryId]);
    const categoryNames = new Map([[template.categoryId, accounts.get(template.categoryId)!.name]]);

    const transactionId = randomUUID();
    const resolution = await resolveLateCaptureCompensation(this.periodRepository, {
      userId,
      bookedAt,
      today,
      entries,
      categoryIds,
      transactionId,
    });

    const result = await this.transactionRepository.createWithEntries(
      userId,
      { id: transactionId, bookedAt: new Date(`${bookedAt}T00:00:00Z`), description, idempotencyKey },
      entries,
      resolution.compensations,
    );

    let updatedTemplate = template;
    if (result.created) {
      // El avance del template solo ocurre cuando la escritura fue
      // efectiva (§6.9) — en la rama de recuperación por idempotencia no
      // se avanza dos veces.
      updatedTemplate = await this.templateRepository.advanceAfterConfirm(
        userId,
        id,
        new Date(`${bookedAt}T00:00:00Z`),
        nextDueOn(template.dayOfMonth, new Date(`${bookedAt}T00:00:00Z`)),
      );
    }

    const budgetImpactDto = BudgetImpactDto.from(resolution.budgetImpact, categoryNames);
    const transactionDto = TransactionResponseDto.from(result.transaction, amountCents, budgetImpactDto);
    const templateAccounts = await this.loadAccountsFor(userId, [updatedTemplate]);
    const templateDto = this.toResponseDto(updatedTemplate, templateAccounts, today);

    return { transaction: transactionDto, template: templateDto, created: result.created };
  }

  private async getOrThrow(userId: string, id: string): Promise<RecurringTemplateRow> {
    const row = await this.templateRepository.findById(userId, id);
    if (!row) {
      throw new RecurringTemplateNotFoundException();
    }
    return row;
  }

  private async loadAccountsFor(userId: string, rows: RecurringTemplateRow[]) {
    const ids = [...new Set(rows.flatMap((r) => [r.categoryId, r.accountId].filter((v): v is string => v !== null)))];
    const accounts = await this.accountRepository.findManyByIds(userId, ids);
    return new Map(accounts.map((a) => [a.id, a]));
  }

  private toResponseDto(row: RecurringTemplateRow, accounts: Map<string, { name: string }>, today: string): RecurringTemplateResponseDto {
    const categoryName = accounts.get(row.categoryId)?.name ?? '';
    const accountName = row.accountId ? accounts.get(row.accountId)?.name ?? null : null;
    return RecurringTemplateResponseDto.from(row, categoryName, accountName, today);
  }
}

function parseDateOnly(value: string): Date {
  return new Date(`${value}T00:00:00Z`);
}
