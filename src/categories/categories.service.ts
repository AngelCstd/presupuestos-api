import { Inject, Injectable } from '@nestjs/common';
import { AccountType, RolloverType } from '@prisma/client';
import type { IAccountRepository } from '../shared/accounts-data/interfaces/account-repository.interface';
import type { IQueryRepository } from '../shared/queries/interfaces/query-repository.interface';
import type { ITransactionRepository } from '../shared/ledger/interfaces/transaction-repository.interface';
import type { CategoryBalanceRow } from '../shared/queries/types';
import type { Paged } from '../common/pagination/types';
import type { CursorPage, EntryCursor } from '../shared/ledger/types';
import { decodeCursor } from '../common/pagination/cursor';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { ListCategoriesQueryDto } from './dto/list-categories.query';
import { CategoryResponseDto } from './dto/category-response.dto';
import { CategoryNotFoundException } from './exceptions/category-not-found.exception';
import { CategoryHasAllocationsException } from './exceptions/category-has-allocations.exception';
import { DuplicateAccountNameException } from '../accounts/exceptions/duplicate-account-name.exception';
import { ArchiveStateException } from '../accounts/exceptions/archive-state.exception';

export interface LedgerEntryResponse {
  transactionId: string;
  bookedAt: string;
  description: string;
  amountCents: bigint;
  createdAt: string;
}

@Injectable()
export class CategoriesService {
  constructor(
    @Inject('IAccountRepository') private readonly accountRepository: IAccountRepository,
    @Inject('IQueryRepository') private readonly queryRepository: IQueryRepository,
    @Inject('ITransactionRepository') private readonly transactionRepository: ITransactionRepository,
  ) {}

  async create(userId: string, dto: CreateCategoryDto): Promise<CategoryResponseDto> {
    if (await this.accountRepository.nameExists(userId, dto.name)) {
      throw new DuplicateAccountNameException();
    }
    const account = await this.accountRepository.create(userId, {
      name: dto.name,
      type: AccountType.Expense,
      currency: dto.currency ?? 'MXN',
      rolloverType: dto.rolloverType === 'accumulate' ? RolloverType.Accumulate : RolloverType.Reset,
    });
    return CategoryResponseDto.from(account, 0n);
  }

  async findMany(userId: string, query: ListCategoriesQueryDto): Promise<Paged<CategoryResponseDto>> {
    const page = await this.accountRepository.findMany(
      userId,
      { types: [AccountType.Expense], includeArchived: query.includeArchived, includeSystem: false },
      { page: query.page, pageSize: query.pageSize },
    );

    const balances = await this.queryRepository.accountBalances(userId);
    const balanceByAccount = new Map(balances.map((b) => [b.accountId, b.balanceCents]));

    let categoryBalances: Map<string, CategoryBalanceRow> | null = null;
    if (query.periodId) {
      const rows = await this.queryRepository.categoryBalances(userId, query.periodId);
      categoryBalances = new Map(rows.map((r) => [r.categoryId, r]));
    }

    return {
      data: page.data.map((a) =>
        CategoryResponseDto.from(a, balanceByAccount.get(a.id) ?? 0n, query.periodId, categoryBalances?.get(a.id)),
      ),
      page: page.page,
      pageSize: page.pageSize,
      total: page.total,
    };
  }

  async findById(userId: string, id: string, periodId?: string): Promise<CategoryResponseDto> {
    const account = await this.getCategoryOrThrow(userId, id);
    const balance = await this.balanceOf(userId, id);
    const row = periodId ? (await this.queryRepository.categoryBalances(userId, periodId)).find((r) => r.categoryId === id) : undefined;
    return CategoryResponseDto.from(account, balance, periodId, row);
  }

  async update(userId: string, id: string, dto: UpdateCategoryDto): Promise<CategoryResponseDto> {
    const account = await this.getCategoryOrThrow(userId, id);
    if (dto.name !== undefined && dto.name !== account.name) {
      if (await this.accountRepository.nameExists(userId, dto.name)) {
        throw new DuplicateAccountNameException();
      }
    }
    const updated = await this.accountRepository.update(userId, id, {
      name: dto.name,
      rolloverType: dto.rolloverType ? (dto.rolloverType === 'accumulate' ? RolloverType.Accumulate : RolloverType.Reset) : undefined,
    });
    return CategoryResponseDto.from(updated, await this.balanceOf(userId, id));
  }

  async archive(userId: string, id: string): Promise<CategoryResponseDto> {
    const account = await this.getCategoryOrThrow(userId, id);
    if (account.archivedAt !== null) {
      throw new ArchiveStateException('ALREADY_ARCHIVED');
    }

    // S-R6, NO R8: R8 exime a `expense` del saldo cero (lo hace el propio
    // trigger de TASK-db) — aquí solo se checan asignaciones vigentes en
    // periodos abiertos.
    if (await this.accountRepository.hasLiveAllocationsInOpenPeriods(userId, id)) {
      throw new CategoryHasAllocationsException();
    }

    const updated = await this.accountRepository.setArchivedAt(userId, id, new Date());
    return CategoryResponseDto.from(updated, await this.balanceOf(userId, id));
  }

  async unarchive(userId: string, id: string): Promise<CategoryResponseDto> {
    const account = await this.getCategoryOrThrow(userId, id);
    if (account.archivedAt === null) {
      throw new ArchiveStateException('NOT_ARCHIVED');
    }
    if (await this.accountRepository.nameExists(userId, account.name, id)) {
      throw new DuplicateAccountNameException();
    }
    const updated = await this.accountRepository.setArchivedAt(userId, id, null);
    return CategoryResponseDto.from(updated, await this.balanceOf(userId, id));
  }

  async ledger(userId: string, id: string, cursorRaw: string | undefined, limit: number): Promise<CursorPage<LedgerEntryResponse>> {
    await this.getCategoryOrThrow(userId, id);
    const cursor = cursorRaw ? (decodeCursor(cursorRaw) as EntryCursor) : null;
    const page = await this.transactionRepository.findEntriesByAccountCursor(userId, id, cursor, limit);
    return {
      data: page.data.map((e) => ({
        transactionId: e.transactionId,
        bookedAt: e.bookedAt.toISOString().slice(0, 10),
        description: e.description,
        amountCents: e.amountCents,
        createdAt: e.createdAt.toISOString(),
      })),
      nextCursor: page.nextCursor,
    };
  }

  private async getCategoryOrThrow(userId: string, id: string) {
    const account = await this.accountRepository.findById(userId, id);
    if (!account || account.type !== AccountType.Expense) {
      throw new CategoryNotFoundException();
    }
    return account;
  }

  private async balanceOf(userId: string, accountId: string): Promise<bigint> {
    const balances = await this.queryRepository.accountBalances(userId);
    return balances.find((b) => b.accountId === accountId)?.balanceCents ?? 0n;
  }
}
