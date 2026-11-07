import type { AccountType, RolloverType } from '@prisma/client';

export interface AccountRow {
  id: string;
  userId: string;
  name: string;
  type: AccountType;
  currency: string;
  rolloverType: RolloverType | null;
  isSystem: boolean;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateAccountData {
  name: string;
  type: AccountType;
  currency: string;
  rolloverType?: RolloverType | null;
  isSystem?: boolean;
}

export interface UpdateAccountData {
  name?: string;
  currency?: string;
  rolloverType?: RolloverType | null;
}
