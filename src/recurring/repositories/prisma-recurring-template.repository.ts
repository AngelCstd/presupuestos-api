import { Injectable } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import type {
  CreateRecurringTemplateData,
  IRecurringTemplateRepository,
  ListRecurringTemplatesFilter,
  RecurringTemplateRow,
  UpdateRecurringTemplateData,
} from '../interfaces/recurring-template-repository.interface';
import type { OffsetPage, Paged } from '../../common/pagination/types';

/**
 * `recurring_templates` no tiene ningún trigger propio (ARCHITECTURE.md
 * §3.4, tabla de 9 triggers — ninguno la menciona) — a diferencia de
 * `transactions`/`entries`/`budget_entries`, los métodos TIPADOS de
 * Prisma son seguros aquí, sin el riesgo de perder el SQLSTATE que
 * obligó a `$queryRaw` en `PrismaTransactionRepository`/
 * `PrismaAllocationRepository`.
 */
@Injectable()
export class PrismaRecurringTemplateRepository implements IRecurringTemplateRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(userId: string, data: CreateRecurringTemplateData): Promise<RecurringTemplateRow> {
    return this.prisma.recurringTemplate.create({
      data: {
        userId,
        name: data.name,
        accountId: data.accountId,
        categoryId: data.categoryId,
        amountCents: data.amountCents,
        dayOfMonth: data.dayOfMonth,
        nextDueOn: data.nextDueOn,
      },
    });
  }

  async findMany(userId: string, filter: ListRecurringTemplatesFilter, page: OffsetPage): Promise<Paged<RecurringTemplateRow>> {
    const where: Prisma.RecurringTemplateWhereInput = {
      userId,
      deletedAt: null,
      ...(filter.includeInactive ? {} : { isActive: true }),
      ...(filter.dueOnly ? { nextDueOn: { lte: new Date(`${filter.today}T00:00:00Z`) } } : {}),
    };

    const [data, total] = await Promise.all([
      this.prisma.recurringTemplate.findMany({
        where,
        skip: (page.page - 1) * page.pageSize,
        take: page.pageSize,
        orderBy: { nextDueOn: 'asc' },
      }),
      this.prisma.recurringTemplate.count({ where }),
    ]);

    return { data, page: page.page, pageSize: page.pageSize, total };
  }

  async findById(userId: string, id: string): Promise<RecurringTemplateRow | null> {
    return this.prisma.recurringTemplate.findFirst({ where: { id, userId, deletedAt: null } });
  }

  async update(userId: string, id: string, data: UpdateRecurringTemplateData): Promise<RecurringTemplateRow> {
    return this.prisma.recurringTemplate.update({
      where: { id },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.accountId !== undefined ? { accountId: data.accountId } : {}),
        ...(data.categoryId !== undefined ? { categoryId: data.categoryId } : {}),
        ...(data.amountCents !== undefined ? { amountCents: data.amountCents } : {}),
        ...(data.dayOfMonth !== undefined ? { dayOfMonth: data.dayOfMonth } : {}),
        ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
      },
    });
  }

  async softDelete(userId: string, id: string): Promise<RecurringTemplateRow> {
    return this.prisma.recurringTemplate.update({ where: { id }, data: { deletedAt: new Date() } });
  }

  async advanceAfterConfirm(userId: string, id: string, lastConfirmedOn: Date, nextDueOn: Date): Promise<RecurringTemplateRow> {
    return this.prisma.recurringTemplate.update({ where: { id }, data: { lastConfirmedOn, nextDueOn } });
  }
}
