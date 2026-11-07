import type { AccountType } from '@prisma/client';
import type { OffsetPage, Paged } from '../../../common/pagination/types';
import type { AccountRow, CreateAccountData, UpdateAccountData } from '../types';

export interface IAccountRepository {
  create(userId: string, data: CreateAccountData): Promise<AccountRow>;
  findById(userId: string, id: string): Promise<AccountRow | null>;
  findManyByIds(userId: string, ids: string[]): Promise<AccountRow[]>;
  findMany(
    userId: string,
    filter: { types: AccountType[]; includeArchived: boolean; includeSystem: boolean },
    page: OffsetPage,
  ): Promise<Paged<AccountRow>>;
  findSystemEquity(userId: string): Promise<AccountRow | null>;
  update(userId: string, id: string, data: UpdateAccountData): Promise<AccountRow>;
  setArchivedAt(userId: string, id: string, value: Date | null): Promise<AccountRow>;
  hasEntries(userId: string, accountId: string): Promise<boolean>;
  hasLiveAllocationsInOpenPeriods(userId: string, categoryId: string): Promise<boolean>;
  nameExists(userId: string, name: string, excludeId?: string): Promise<boolean>;
}
