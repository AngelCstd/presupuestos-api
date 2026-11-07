import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { AccountType } from '@prisma/client';
import type { IAccountRepository } from '../shared/accounts-data/interfaces/account-repository.interface';
import type { ITransactionRepository } from '../shared/ledger/interfaces/transaction-repository.interface';
import type { IBudgetPeriodRepository } from '../shared/periods-data/interfaces/period-repository.interface';
import type { AccountRow } from '../shared/accounts-data/types';
import type { EntryDraft } from '../shared/ledger/entry-builders';
import type { TransactionRow } from '../shared/ledger/types';
import type { TxCursor } from '../shared/ledger/types';
import {
  buildExpenseEntries,
  buildIncomeEntries,
  buildTransferEntries,
  buildLoanEntries,
  buildLoanRepaymentEntries,
  buildLoanWriteOffEntries,
  buildOpeningBalanceEntries,
  buildReversalEntries,
} from '../shared/ledger/entry-builders';
import { resolveLateCaptureCompensation, originalGeneratedCompensation } from '../shared/ledger/late-capture';
import { validateAndLoadAccounts, type AccountRoleSpec } from '../shared/ledger/account-roles';
import { todayInTimezone } from '../shared/time/today-in-timezone';
import { decodeCursor } from '../common/pagination/cursor';
import type { CursorPage } from '../shared/ledger/types';

import { CreateExpenseDto } from './dto/create-expense.dto';
import { CreateIncomeDto } from './dto/create-income.dto';
import { CreateTransferDto } from './dto/create-transfer.dto';
import { CreateLoanDto } from './dto/create-loan.dto';
import { CreateLoanRepaymentDto } from './dto/create-loan-repayment.dto';
import { CreateLoanWriteOffDto } from './dto/create-loan-write-off.dto';
import { CreateOpeningBalanceDto } from './dto/create-opening-balance.dto';
import { CreateReversalDto } from './dto/create-reversal.dto';
import { UpdateTransactionDto } from './dto/update-transaction.dto';
import { ListTransactionsQueryDto } from './dto/list-transactions.query';
import { TransactionResponseDto, BudgetImpactDto } from '../shared/ledger/dto/transaction-response.dto';
import { TransactionDetailResponseDto } from './dto/transaction-detail-response.dto';

import { TransactionNotFoundException } from './exceptions/transaction-not-found.exception';
import { InvalidReversalException } from './exceptions/invalid-reversal.exception';
import { ReversalDateLockedException } from './exceptions/reversal-date-locked.exception';

const ASSET_LIABILITY: AccountType[] = [AccountType.Asset, AccountType.Liability];
const EXPENSE: AccountType[] = [AccountType.Expense];
const INCOME: AccountType[] = [AccountType.Income];
const RECEIVABLE: AccountType[] = [AccountType.Receivable];

export interface CreateResult {
  dto: TransactionResponseDto;
  created: boolean;
}

@Injectable()
export class TransactionsService {
  constructor(
    @Inject('IAccountRepository') private readonly accountRepository: IAccountRepository,
    @Inject('ITransactionRepository') private readonly transactionRepository: ITransactionRepository,
    @Inject('IBudgetPeriodRepository') private readonly periodRepository: IBudgetPeriodRepository,
  ) {}

  async createExpense(userId: string, timezone: string, dto: CreateExpenseDto, idempotencyKey: string): Promise<CreateResult> {
    const specs: AccountRoleSpec[] = [
      { id: dto.paidFromAccountId, allowedTypes: ASSET_LIABILITY },
      ...dto.lines.map((l) => ({ id: l.categoryId, allowedTypes: EXPENSE })),
      ...(dto.lentTo ?? []).map((l) => ({ id: l.receivableAccountId, allowedTypes: RECEIVABLE })),
    ];
    const accounts = await validateAndLoadAccounts(this.accountRepository, userId, specs);

    const entries = buildExpenseEntries({
      paidFromAccountId: dto.paidFromAccountId,
      lines: dto.lines.map((l) => ({ categoryId: l.categoryId, amountCents: l.amountCents })),
      lentTo: dto.lentTo?.map((l) => ({ receivableAccountId: l.receivableAccountId, amountCents: l.amountCents })),
      totalCents: dto.totalCents,
    });

    const categoryIds = new Set(dto.lines.map((l) => l.categoryId));
    return this.createLedgerTransaction(userId, timezone, {
      bookedAt: dto.bookedAt,
      description: dto.description,
      entries,
      categoryIds,
      categoryNames: this.namesFor(accounts, categoryIds),
      totalCents: dto.totalCents,
      idempotencyKey,
    });
  }

  async createIncome(userId: string, timezone: string, dto: CreateIncomeDto, idempotencyKey: string): Promise<CreateResult> {
    await validateAndLoadAccounts(this.accountRepository, userId, [
      { id: dto.toAccountId, allowedTypes: ASSET_LIABILITY },
      { id: dto.sourceId, allowedTypes: INCOME },
    ]);

    const entries = buildIncomeEntries({ toAccountId: dto.toAccountId, sourceId: dto.sourceId, amountCents: dto.amountCents });
    return this.createLedgerTransaction(userId, timezone, {
      bookedAt: dto.bookedAt,
      description: dto.description,
      entries,
      categoryIds: new Set(),
      categoryNames: new Map(),
      totalCents: dto.amountCents,
      idempotencyKey,
    });
  }

  async createTransfer(userId: string, timezone: string, dto: CreateTransferDto, idempotencyKey: string): Promise<CreateResult> {
    await validateAndLoadAccounts(this.accountRepository, userId, [
      { id: dto.fromAccountId, allowedTypes: ASSET_LIABILITY },
      { id: dto.toAccountId, allowedTypes: ASSET_LIABILITY },
    ]);

    const entries = buildTransferEntries({ fromAccountId: dto.fromAccountId, toAccountId: dto.toAccountId, amountCents: dto.amountCents });
    return this.createLedgerTransaction(userId, timezone, {
      bookedAt: dto.bookedAt,
      description: dto.description,
      entries,
      categoryIds: new Set(),
      categoryNames: new Map(),
      totalCents: dto.amountCents,
      idempotencyKey,
    });
  }

  async createLoan(userId: string, timezone: string, dto: CreateLoanDto, idempotencyKey: string): Promise<CreateResult> {
    await validateAndLoadAccounts(this.accountRepository, userId, [
      { id: dto.fromAccountId, allowedTypes: ASSET_LIABILITY },
      { id: dto.receivableAccountId, allowedTypes: RECEIVABLE },
    ]);

    const entries = buildLoanEntries({ fromAccountId: dto.fromAccountId, receivableAccountId: dto.receivableAccountId, amountCents: dto.amountCents });
    return this.createLedgerTransaction(userId, timezone, {
      bookedAt: dto.bookedAt,
      description: dto.description,
      entries,
      categoryIds: new Set(),
      categoryNames: new Map(),
      totalCents: dto.amountCents,
      idempotencyKey,
    });
  }

  async createLoanRepayment(userId: string, timezone: string, dto: CreateLoanRepaymentDto, idempotencyKey: string): Promise<CreateResult> {
    await validateAndLoadAccounts(this.accountRepository, userId, [
      { id: dto.receivableAccountId, allowedTypes: RECEIVABLE },
      { id: dto.toAccountId, allowedTypes: ASSET_LIABILITY },
    ]);

    const entries = buildLoanRepaymentEntries({ receivableAccountId: dto.receivableAccountId, toAccountId: dto.toAccountId, amountCents: dto.amountCents });
    return this.createLedgerTransaction(userId, timezone, {
      bookedAt: dto.bookedAt,
      description: dto.description,
      entries,
      categoryIds: new Set(),
      categoryNames: new Map(),
      totalCents: dto.amountCents,
      idempotencyKey,
    });
  }

  async createLoanWriteOff(userId: string, timezone: string, dto: CreateLoanWriteOffDto, idempotencyKey: string): Promise<CreateResult> {
    const accounts = await validateAndLoadAccounts(this.accountRepository, userId, [
      { id: dto.receivableAccountId, allowedTypes: RECEIVABLE },
      { id: dto.categoryId, allowedTypes: EXPENSE },
    ]);

    const entries = buildLoanWriteOffEntries({ receivableAccountId: dto.receivableAccountId, categoryId: dto.categoryId, amountCents: dto.amountCents });
    const categoryIds = new Set([dto.categoryId]);
    return this.createLedgerTransaction(userId, timezone, {
      bookedAt: dto.bookedAt,
      description: dto.description,
      entries,
      categoryIds,
      categoryNames: this.namesFor(accounts, categoryIds),
      totalCents: dto.amountCents,
      idempotencyKey,
    });
  }

  async createOpeningBalance(userId: string, timezone: string, dto: CreateOpeningBalanceDto, idempotencyKey: string): Promise<CreateResult> {
    await validateAndLoadAccounts(
      this.accountRepository,
      userId,
      dto.balances.map((b) => ({ id: b.accountId, allowedTypes: [AccountType.Asset, AccountType.Liability, AccountType.Receivable] })),
    );

    const equityAccount = await this.accountRepository.findSystemEquity(userId);
    const entries = buildOpeningBalanceEntries({
      balances: dto.balances.map((b) => ({ accountId: b.accountId, balanceCents: b.balanceCents })),
      equityAccountId: equityAccount!.id,
    });

    const totalCents = entries.filter((e) => e.amountCents > 0n).reduce((acc, e) => acc + e.amountCents, 0n);
    return this.createLedgerTransaction(userId, timezone, {
      bookedAt: dto.bookedAt,
      description: dto.description ?? 'Saldos iniciales',
      entries,
      categoryIds: new Set(),
      categoryNames: new Map(),
      totalCents,
      idempotencyKey,
    });
  }

  async createReversal(userId: string, timezone: string, transactionId: string, dto: CreateReversalDto, idempotencyKey: string): Promise<CreateResult> {
    const original = await this.transactionRepository.findById(userId, transactionId);
    if (!original) {
      throw new TransactionNotFoundException();
    }
    if (original.reversesTransactionId !== null) {
      throw new InvalidReversalException('CANNOT_REVERSE_REVERSAL');
    }
    const existingReversal = await this.transactionRepository.findReversalOf(userId, transactionId);
    if (existingReversal) {
      throw new InvalidReversalException('ALREADY_REVERSED');
    }

    const originalBookedAt = original.bookedAt.toISOString().slice(0, 10);
    if (dto.bookedAt !== undefined) {
      const locked = await originalGeneratedCompensation(this.periodRepository, userId, originalBookedAt);
      if (locked) {
        throw new ReversalDateLockedException();
      }
    }
    const bookedAt = dto.bookedAt ?? originalBookedAt;
    const description = dto.description ?? original.description;

    const originalEntries: EntryDraft[] = original.entries.map((e) => ({ accountId: e.accountId, amountCents: e.amountCents }));
    const entries = buildReversalEntries(originalEntries);

    const touchedAccountIds = [...new Set(entries.map((e) => e.accountId))];
    const touchedAccounts = await this.accountRepository.findManyByIds(userId, touchedAccountIds);
    const categoryIds = new Set(touchedAccounts.filter((a) => a.type === AccountType.Expense).map((a) => a.id));
    const categoryNames = new Map(touchedAccounts.filter((a) => categoryIds.has(a.id)).map((a) => [a.id, a.name]));

    const totalCents = entries.filter((e) => e.amountCents > 0n).reduce((acc, e) => acc + e.amountCents, 0n);

    const transactionId2 = randomUUID();
    const today = todayInTimezone(timezone);
    const resolution = await resolveLateCaptureCompensation(this.periodRepository, {
      userId,
      bookedAt,
      today,
      entries,
      categoryIds,
      transactionId: transactionId2,
    });

    const result = await this.transactionRepository.createWithEntries(
      userId,
      {
        id: transactionId2,
        bookedAt: new Date(`${bookedAt}T00:00:00Z`),
        description,
        idempotencyKey,
        reversesTransactionId: transactionId,
      },
      entries,
      resolution.compensations,
    );

    const budgetImpactDto = BudgetImpactDto.from(resolution.budgetImpact, categoryNames);
    return { dto: TransactionResponseDto.from(result.transaction, totalCents, budgetImpactDto), created: result.created };
  }

  async findMany(userId: string, query: ListTransactionsQueryDto): Promise<CursorPage<TransactionDetailResponseDto>> {
    const cursor = query.cursor ? (decodeCursor(query.cursor) as TxCursor) : null;
    const page = await this.transactionRepository.findManyByCursor(
      userId,
      { from: query.from, to: query.to, accountId: query.accountId, categoryId: query.categoryId },
      cursor,
      query.limit,
    );

    const accountIds = [...new Set(page.data.flatMap((t) => t.entries.map((e) => e.accountId)))];
    const accounts = await this.accountRepository.findManyByIds(userId, accountIds);
    const accountsById = new Map(accounts.map((a) => [a.id, a]));

    const data = await Promise.all(
      page.data.map(async (t) => {
        const reversal = await this.transactionRepository.findReversalOf(userId, t.id);
        return TransactionDetailResponseDto.from(t, t.entries, accountsById, reversal?.id ?? null);
      }),
    );

    return { data, nextCursor: page.nextCursor };
  }

  async findById(userId: string, id: string): Promise<TransactionDetailResponseDto> {
    const transaction = await this.transactionRepository.findById(userId, id);
    if (!transaction) {
      throw new TransactionNotFoundException();
    }
    const accountIds = [...new Set(transaction.entries.map((e) => e.accountId))];
    const accounts = await this.accountRepository.findManyByIds(userId, accountIds);
    const accountsById = new Map(accounts.map((a) => [a.id, a]));
    const reversal = await this.transactionRepository.findReversalOf(userId, id);
    return TransactionDetailResponseDto.from(transaction, transaction.entries, accountsById, reversal?.id ?? null);
  }

  async updateDescription(userId: string, id: string, dto: UpdateTransactionDto): Promise<TransactionDetailResponseDto> {
    const existing = await this.transactionRepository.findById(userId, id);
    if (!existing) {
      throw new TransactionNotFoundException();
    }
    await this.transactionRepository.updateDescription(userId, id, dto.description);
    return this.findById(userId, id);
  }

  private namesFor(accounts: Map<string, AccountRow>, ids: Set<string>): Map<string, string> {
    const names = new Map<string, string>();
    for (const id of ids) {
      const account = accounts.get(id);
      if (account) names.set(id, account.name);
    }
    return names;
  }

  private async createLedgerTransaction(
    userId: string,
    timezone: string,
    params: {
      bookedAt: string;
      description: string;
      entries: EntryDraft[];
      categoryIds: Set<string>;
      categoryNames: Map<string, string>;
      totalCents: bigint;
      idempotencyKey: string;
    },
  ): Promise<CreateResult> {
    const transactionId = randomUUID();
    const today = todayInTimezone(timezone);
    const resolution = await resolveLateCaptureCompensation(this.periodRepository, {
      userId,
      bookedAt: params.bookedAt,
      today,
      entries: params.entries,
      categoryIds: params.categoryIds,
      transactionId,
    });

    const result = await this.transactionRepository.createWithEntries(
      userId,
      {
        id: transactionId,
        bookedAt: new Date(`${params.bookedAt}T00:00:00Z`),
        description: params.description,
        idempotencyKey: params.idempotencyKey,
      },
      params.entries,
      resolution.compensations,
    );

    const budgetImpactDto = BudgetImpactDto.from(resolution.budgetImpact, params.categoryNames);
    const dto = TransactionResponseDto.from(result.transaction as TransactionRow, params.totalCents, budgetImpactDto);
    return { dto, created: result.created };
  }
}
