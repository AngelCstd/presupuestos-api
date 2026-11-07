import { Inject, Injectable } from '@nestjs/common';
import { AccountType } from '@prisma/client';
import type { IBudgetPeriodRepository } from '../shared/periods-data/interfaces/period-repository.interface';
import type { IAllocationRepository } from './interfaces/allocation-repository.interface';
import type { IAccountRepository } from '../shared/accounts-data/interfaces/account-repository.interface';
import type { IQueryRepository } from '../shared/queries/interfaces/query-repository.interface';
import { PeriodNotFoundException } from '../shared/periods-data/exceptions/period-not-found.exception';
import { ClosedPeriodException } from './exceptions/closed-period.exception';
import { AllocationNotFoundException } from './exceptions/allocation-not-found.exception';
import { InvalidBudgetCategoryException } from './exceptions/invalid-budget-category.exception';
import { SameAccountException } from '../transactions/exceptions/same-account.exception';
import { CreateAllocationDto } from './dto/create-allocation.dto';
import { SetAllocationDto } from './dto/set-allocation.dto';
import { MoveAllocationDto } from './dto/move-allocation.dto';
import { AllocationResponseDto } from './dto/allocation-response.dto';
import { AllocationSetResponseDto } from './dto/allocation-set-response.dto';

@Injectable()
export class AllocationsService {
  constructor(
    @Inject('IBudgetPeriodRepository') private readonly periodRepository: IBudgetPeriodRepository,
    @Inject('IAllocationRepository') private readonly allocationRepository: IAllocationRepository,
    @Inject('IAccountRepository') private readonly accountRepository: IAccountRepository,
    @Inject('IQueryRepository') private readonly queryRepository: IQueryRepository,
  ) {}

  async findMany(userId: string, periodId: string): Promise<{ allocations: AllocationResponseDto[] }> {
    await this.getPeriodOrThrow(userId, periodId);
    const rows = await this.allocationRepository.findManyByPeriod(userId, periodId);
    const categories = await this.accountRepository.findManyByIds(userId, [...new Set(rows.map((r) => r.categoryId))]);
    const namesById = new Map(categories.map((c) => [c.id, c.name]));
    return { allocations: rows.map((r) => AllocationResponseDto.from(r, namesById.get(r.categoryId) ?? '')) };
  }

  async create(userId: string, periodId: string, dto: CreateAllocationDto): Promise<AllocationResponseDto> {
    const period = await this.getPeriodOrThrow(userId, periodId);
    if (period.closedAt !== null) {
      throw new ClosedPeriodException('PERIOD_CLOSED');
    }
    const category = await this.accountRepository.findById(userId, dto.categoryId);
    if (!category || category.type !== AccountType.Expense) {
      throw new InvalidBudgetCategoryException();
    }

    const row = await this.allocationRepository.create(userId, periodId, dto.categoryId, dto.amountCents, 'manual', dto.note ?? null);
    return AllocationResponseDto.from(row, category.name);
  }

  async setTarget(userId: string, periodId: string, categoryId: string, dto: SetAllocationDto): Promise<AllocationSetResponseDto> {
    const category = await this.accountRepository.findById(userId, categoryId);
    if (!category || category.type !== AccountType.Expense) {
      throw new InvalidBudgetCategoryException();
    }

    await this.periodRepository.runInTransaction(async (tx) => {
      const period = await this.periodRepository.lockForUpdate(tx, userId, periodId);
      if (!period) {
        throw new PeriodNotFoundException();
      }
      if (period.closedAt !== null) {
        throw new ClosedPeriodException('PERIOD_CLOSED');
      }

      // T-L07 — el delta se calcula DENTRO de la transacción, después del
      // `FOR UPDATE` sobre la fila del periodo: es lo que serializa dos
      // `PUT` concurrentes. Calcularlo antes reintroduce el bug.
      const current = await this.allocationRepository.sumAssignedTx(tx, userId, periodId, categoryId);
      const delta = dto.targetAssignedCents - current;
      if (delta !== 0n) {
        await this.allocationRepository.insertTx(tx, userId, periodId, categoryId, delta, 'manual', null);
      }
    });

    const balances = await this.queryRepository.categoryBalances(userId, periodId);
    const row = balances.find((b) => b.categoryId === categoryId)!;
    return AllocationSetResponseDto.from(periodId, row);
  }

  async move(userId: string, periodId: string, dto: MoveAllocationDto): Promise<{ from: AllocationSetResponseDto; to: AllocationSetResponseDto }> {
    if (dto.fromCategoryId === dto.toCategoryId) {
      throw new SameAccountException('SAME_CATEGORY_MOVE');
    }
    const categories = await this.accountRepository.findManyByIds(userId, [dto.fromCategoryId, dto.toCategoryId]);
    const byId = new Map(categories.map((c) => [c.id, c]));
    if (byId.get(dto.fromCategoryId)?.type !== AccountType.Expense || byId.get(dto.toCategoryId)?.type !== AccountType.Expense) {
      throw new InvalidBudgetCategoryException();
    }

    await this.periodRepository.runInTransaction(async (tx) => {
      const period = await this.periodRepository.lockForUpdate(tx, userId, periodId);
      if (!period) {
        throw new PeriodNotFoundException();
      }
      if (period.closedAt !== null) {
        throw new ClosedPeriodException('PERIOD_CLOSED');
      }

      await this.allocationRepository.insertTx(tx, userId, periodId, dto.fromCategoryId, -dto.amountCents, 'manual', null);
      await this.allocationRepository.insertTx(tx, userId, periodId, dto.toCategoryId, dto.amountCents, 'manual', null);
    });

    const balances = await this.queryRepository.categoryBalances(userId, periodId);
    const from = balances.find((b) => b.categoryId === dto.fromCategoryId)!;
    const to = balances.find((b) => b.categoryId === dto.toCategoryId)!;
    return { from: AllocationSetResponseDto.from(periodId, from), to: AllocationSetResponseDto.from(periodId, to) };
  }

  async remove(userId: string, periodId: string, allocationId: string): Promise<void> {
    const allocation = await this.allocationRepository.findById(userId, allocationId);
    if (!allocation || allocation.periodId !== periodId) {
      throw new AllocationNotFoundException();
    }
    const period = await this.getPeriodOrThrow(userId, periodId);
    if (period.closedAt !== null) {
      throw new ClosedPeriodException('PERIOD_CLOSED');
    }
    await this.allocationRepository.softDelete(userId, allocationId);
  }

  private async getPeriodOrThrow(userId: string, periodId: string) {
    const period = await this.periodRepository.findById(userId, periodId);
    if (!period) {
      throw new PeriodNotFoundException();
    }
    return period;
  }
}
