import { Inject, Injectable } from '@nestjs/common';
import { AccountType } from '@prisma/client';
import type { IAccountRepository } from '../shared/accounts-data/interfaces/account-repository.interface';
import type { IQueryRepository } from '../shared/queries/interfaces/query-repository.interface';
import type { Paged } from '../common/pagination/types';
import { CreateIncomeSourceDto } from './dto/create-income-source.dto';
import { UpdateIncomeSourceDto } from './dto/update-income-source.dto';
import { IncomeSourceResponseDto } from './dto/income-source-response.dto';
import { IncomeSourceNotFoundException } from './exceptions/income-source-not-found.exception';
import { DuplicateAccountNameException } from '../accounts/exceptions/duplicate-account-name.exception';
import { ArchiveStateException } from '../accounts/exceptions/archive-state.exception';

@Injectable()
export class IncomeSourcesService {
  constructor(
    @Inject('IAccountRepository') private readonly accountRepository: IAccountRepository,
    @Inject('IQueryRepository') private readonly queryRepository: IQueryRepository,
  ) {}

  async create(userId: string, dto: CreateIncomeSourceDto): Promise<IncomeSourceResponseDto> {
    if (await this.accountRepository.nameExists(userId, dto.name)) {
      throw new DuplicateAccountNameException();
    }
    const account = await this.accountRepository.create(userId, {
      name: dto.name,
      type: AccountType.Income,
      currency: dto.currency ?? 'MXN',
    });
    return IncomeSourceResponseDto.from(account, 0n);
  }

  async findMany(userId: string, query: { includeArchived: boolean; page: number; pageSize: number }): Promise<Paged<IncomeSourceResponseDto>> {
    const page = await this.accountRepository.findMany(
      userId,
      { types: [AccountType.Income], includeArchived: query.includeArchived, includeSystem: false },
      { page: query.page, pageSize: query.pageSize },
    );
    const balances = await this.queryRepository.accountBalances(userId);
    const balanceByAccount = new Map(balances.map((b) => [b.accountId, b.balanceCents]));

    return {
      data: page.data.map((a) => IncomeSourceResponseDto.from(a, balanceByAccount.get(a.id) ?? 0n)),
      page: page.page,
      pageSize: page.pageSize,
      total: page.total,
    };
  }

  async findById(userId: string, id: string): Promise<IncomeSourceResponseDto> {
    const account = await this.getIncomeSourceOrThrow(userId, id);
    return IncomeSourceResponseDto.from(account, await this.balanceOf(userId, id));
  }

  async update(userId: string, id: string, dto: UpdateIncomeSourceDto): Promise<IncomeSourceResponseDto> {
    const account = await this.getIncomeSourceOrThrow(userId, id);
    if (dto.name !== undefined && dto.name !== account.name) {
      if (await this.accountRepository.nameExists(userId, dto.name)) {
        throw new DuplicateAccountNameException();
      }
    }
    const updated = await this.accountRepository.update(userId, id, { name: dto.name });
    return IncomeSourceResponseDto.from(updated, await this.balanceOf(userId, id));
  }

  async archive(userId: string, id: string): Promise<IncomeSourceResponseDto> {
    const account = await this.getIncomeSourceOrThrow(userId, id);
    if (account.archivedAt !== null) {
      throw new ArchiveStateException('ALREADY_ARCHIVED');
    }
    const updated = await this.accountRepository.setArchivedAt(userId, id, new Date());
    return IncomeSourceResponseDto.from(updated, await this.balanceOf(userId, id));
  }

  async unarchive(userId: string, id: string): Promise<IncomeSourceResponseDto> {
    const account = await this.getIncomeSourceOrThrow(userId, id);
    if (account.archivedAt === null) {
      throw new ArchiveStateException('NOT_ARCHIVED');
    }
    if (await this.accountRepository.nameExists(userId, account.name, id)) {
      throw new DuplicateAccountNameException();
    }
    const updated = await this.accountRepository.setArchivedAt(userId, id, null);
    return IncomeSourceResponseDto.from(updated, await this.balanceOf(userId, id));
  }

  private async getIncomeSourceOrThrow(userId: string, id: string) {
    const account = await this.accountRepository.findById(userId, id);
    if (!account || account.type !== AccountType.Income) {
      throw new IncomeSourceNotFoundException();
    }
    return account;
  }

  private async balanceOf(userId: string, accountId: string): Promise<bigint> {
    const balances = await this.queryRepository.accountBalances(userId);
    return balances.find((b) => b.accountId === accountId)?.balanceCents ?? 0n;
  }
}
