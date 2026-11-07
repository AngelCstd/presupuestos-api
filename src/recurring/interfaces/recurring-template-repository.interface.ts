import type { OffsetPage, Paged } from '../../common/pagination/types';

export interface RecurringTemplateRow {
  id: string;
  userId: string;
  name: string;
  accountId: string | null;
  categoryId: string;
  amountCents: bigint;
  dayOfMonth: number;
  nextDueOn: Date;
  lastConfirmedOn: Date | null;
  isActive: boolean;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateRecurringTemplateData {
  name: string;
  accountId: string | null;
  categoryId: string;
  amountCents: bigint;
  dayOfMonth: number;
  nextDueOn: Date;
}

export interface UpdateRecurringTemplateData {
  name?: string;
  accountId?: string | null;
  categoryId?: string;
  amountCents?: bigint;
  dayOfMonth?: number;
  isActive?: boolean;
}

export interface ListRecurringTemplatesFilter {
  dueOnly?: boolean;
  includeInactive?: boolean;
  today: string;
}

export interface IRecurringTemplateRepository {
  create(userId: string, data: CreateRecurringTemplateData): Promise<RecurringTemplateRow>;
  findMany(userId: string, filter: ListRecurringTemplatesFilter, page: OffsetPage): Promise<Paged<RecurringTemplateRow>>;
  findById(userId: string, id: string): Promise<RecurringTemplateRow | null>;
  update(userId: string, id: string, data: UpdateRecurringTemplateData): Promise<RecurringTemplateRow>;
  softDelete(userId: string, id: string): Promise<RecurringTemplateRow>;
  advanceAfterConfirm(userId: string, id: string, lastConfirmedOn: Date, nextDueOn: Date): Promise<RecurringTemplateRow>;
}
