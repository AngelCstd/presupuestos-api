import { Inject, Injectable } from '@nestjs/common';
import type { IAccountRepository } from '../shared/accounts-data/interfaces/account-repository.interface';
import type { IQueryRepository } from '../shared/queries/interfaces/query-repository.interface';
import type { ITransactionRepository } from '../shared/ledger/interfaces/transaction-repository.interface';
import type { Paged } from '../common/pagination/types';
import type { CursorPage, EntryCursor } from '../shared/ledger/types';
import { decodeCursor } from '../common/pagination/cursor';
import { KIND_TO_TYPE } from '../shared/accounts-data/kind-mapping';
import { CreateAccountDto } from './dto/create-account.dto';
import { UpdateAccountDto } from './dto/update-account.dto';
import { ListAccountsQueryDto } from './dto/list-accounts.query';
import { AccountResponseDto } from './dto/account-response.dto';
import { AccountNotFoundException } from '../shared/accounts-data/exceptions/account-not-found.exception';
import { DuplicateAccountNameException } from './exceptions/duplicate-account-name.exception';
import { ArchiveStateException } from './exceptions/archive-state.exception';
import { CurrencyLockedException } from './exceptions/currency-locked.exception';
import { AccountNotEmptyException } from './exceptions/account-not-empty.exception';

const ADDRESSABLE_KINDS = ['cash', 'credit', 'receivable'] as const;

export interface LedgerEntryResponse {
  transactionId: string;
  bookedAt: string;
  description: string;
  amountCents: bigint;
  createdAt: string;
}

@Injectable()
export class AccountsService {
  constructor(
    @Inject('IAccountRepository') private readonly accountRepository: IAccountRepository,
    @Inject('IQueryRepository') private readonly queryRepository: IQueryRepository,
    @Inject('ITransactionRepository') private readonly transactionRepository: ITransactionRepository,
  ) {}

  async create(userId: string, dto: CreateAccountDto): Promise<AccountResponseDto> {
    if (await this.accountRepository.nameExists(userId, dto.name)) {
      throw new DuplicateAccountNameException();
    }

    const account = await this.accountRepository.create(userId, {
      name: dto.name,
      type: KIND_TO_TYPE[dto.kind],
      currency: dto.currency ?? 'MXN',
    });
    return AccountResponseDto.from(account, 0n);
  }

  async findMany(userId: string, query: ListAccountsQueryDto): Promise<Paged<AccountResponseDto>> {
    const types = (query.kind ? [query.kind] : ADDRESSABLE_KINDS).map((k) => KIND_TO_TYPE[k]);

    const page = await this.accountRepository.findMany(
      userId,
      { types, includeArchived: query.includeArchived, includeSystem: false },
      { page: query.page, pageSize: query.pageSize },
    );

    // T-G07 — UNA sola llamada a accountBalances para toda la página, sin
    // importar cuántas cuentas: nunca una query por fila.
    const balances = await this.queryRepository.accountBalances(userId);
    const balanceByAccount = new Map(balances.map((b) => [b.accountId, b.balanceCents]));

    return {
      data: page.data.map((a) => AccountResponseDto.from(a, balanceByAccount.get(a.id) ?? 0n)),
      page: page.page,
      pageSize: page.pageSize,
      total: page.total,
    };
  }

  async findById(userId: string, id: string): Promise<AccountResponseDto> {
    const account = await this.getAddressableOrThrow(userId, id);
    const balance = await this.balanceOf(userId, id);
    return AccountResponseDto.from(account, balance);
  }

  async update(userId: string, id: string, dto: UpdateAccountDto): Promise<AccountResponseDto> {
    const account = await this.getAddressableOrThrow(userId, id);

    if (dto.currency !== undefined && dto.currency !== account.currency) {
      if (await this.accountRepository.hasEntries(userId, id)) {
        throw new CurrencyLockedException();
      }
    }
    if (dto.name !== undefined && dto.name !== account.name) {
      if (await this.accountRepository.nameExists(userId, dto.name)) {
        throw new DuplicateAccountNameException();
      }
    }

    const updated = await this.accountRepository.update(userId, id, { name: dto.name, currency: dto.currency });
    return AccountResponseDto.from(updated, await this.balanceOf(userId, id));
  }

  async archive(userId: string, id: string): Promise<AccountResponseDto> {
    const account = await this.getAddressableOrThrow(userId, id);
    if (account.archivedAt !== null) {
      throw new ArchiveStateException('ALREADY_ARCHIVED');
    }

    const balance = await this.balanceOf(userId, id);
    if (balance !== 0n) {
      throw new AccountNotEmptyException();
    }

    const updated = await this.accountRepository.setArchivedAt(userId, id, new Date());
    return AccountResponseDto.from(updated, balance);
  }

  async unarchive(userId: string, id: string): Promise<AccountResponseDto> {
    const account = await this.getAddressableOrThrow(userId, id);
    if (account.archivedAt === null) {
      throw new ArchiveStateException('NOT_ARCHIVED');
    }
    if (await this.accountRepository.nameExists(userId, account.name, id)) {
      throw new DuplicateAccountNameException();
    }

    const updated = await this.accountRepository.setArchivedAt(userId, id, null);
    return AccountResponseDto.from(updated, await this.balanceOf(userId, id));
  }

  async ledger(userId: string, id: string, cursorRaw: string | undefined, limit: number): Promise<CursorPage<LedgerEntryResponse>> {
    await this.getAddressableOrThrow(userId, id);
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

  /** §6.5 — nunca se devuelve una cuenta `is_system = true`. */
  private async getAddressableOrThrow(userId: string, id: string) {
    const account = await this.accountRepository.findById(userId, id);
    if (!account || account.isSystem) {
      throw new AccountNotFoundException();
    }
    return account;
  }

  private async balanceOf(userId: string, accountId: string): Promise<bigint> {
    const balances = await this.queryRepository.accountBalances(userId);
    return balances.find((b) => b.accountId === accountId)?.balanceCents ?? 0n;
  }
}
