import { Inject, Injectable } from '@nestjs/common';
import type { Prisma, RolloverType } from '@prisma/client';
import type { IBudgetPeriodRepository } from '../shared/periods-data/interfaces/period-repository.interface';
import type { IAllocationRepository } from './interfaces/allocation-repository.interface';
import type { IQueryRepository } from '../shared/queries/interfaces/query-repository.interface';
import type { IAccountRepository } from '../shared/accounts-data/interfaces/account-repository.interface';
import type { PeriodRow } from '../shared/periods-data/types';
import type { Paged } from '../common/pagination/types';
import { todayInTimezone } from '../shared/time/today-in-timezone';
import { PeriodNotFoundException } from '../shared/periods-data/exceptions/period-not-found.exception';
import { NoCurrentPeriodException } from './exceptions/no-current-period.exception';
import { NextPeriodRequiredException } from './exceptions/next-period-required.exception';
import { EarlierPeriodOpenException } from './exceptions/earlier-period-open.exception';
import { PeriodNotEmptyException } from './exceptions/period-not-empty.exception';
import { ClosedPeriodException } from './exceptions/closed-period.exception';
import { DomainException } from '../common/errors/domain.exception';
import { CreatePeriodDto } from './dto/create-period.dto';
import { UpdatePeriodDto } from './dto/update-period.dto';
import { ListPeriodsQueryDto } from './dto/list-periods.query';
import { PeriodResponseDto } from '../shared/periods-data/dto/period-response.dto';
import { ClosePreviewResponseDto, type CategoryCloseActionDto } from './dto/close-preview-response.dto';
import { CloseResponseDto, type CategoryAmountDto } from './dto/close-response.dto';

function parseDateOnly(value: string): Date {
  return new Date(`${value}T00:00:00Z`);
}

interface BlockerCheck {
  blockers: string[];
  nextPeriod: PeriodRow | null;
}

@Injectable()
export class PeriodsService {
  constructor(
    @Inject('IBudgetPeriodRepository') private readonly periodRepository: IBudgetPeriodRepository,
    @Inject('IAllocationRepository') private readonly allocationRepository: IAllocationRepository,
    @Inject('IQueryRepository') private readonly queryRepository: IQueryRepository,
    @Inject('IAccountRepository') private readonly accountRepository: IAccountRepository,
  ) {}

  async create(userId: string, dto: CreatePeriodDto): Promise<PeriodResponseDto> {
    const period = await this.periodRepository.create(userId, {
      startsOn: parseDateOnly(dto.startsOn),
      endsOn: parseDateOnly(dto.endsOn),
    });
    return PeriodResponseDto.from(period);
  }

  async findMany(userId: string, query: ListPeriodsQueryDto): Promise<Paged<PeriodResponseDto>> {
    const page = await this.periodRepository.findMany(userId, { status: query.status }, { page: query.page, pageSize: query.pageSize });
    return { data: page.data.map(PeriodResponseDto.from), page: page.page, pageSize: page.pageSize, total: page.total };
  }

  async findCurrent(userId: string, timezone: string): Promise<PeriodResponseDto> {
    const today = todayInTimezone(timezone);
    const period = await this.periodRepository.findPeriodCoveringDate(userId, today);
    if (!period) {
      throw new NoCurrentPeriodException();
    }
    return PeriodResponseDto.from(period);
  }

  async findById(userId: string, id: string): Promise<PeriodResponseDto> {
    return PeriodResponseDto.from(await this.getOrThrow(userId, id));
  }

  async update(userId: string, id: string, dto: UpdatePeriodDto): Promise<PeriodResponseDto> {
    const period = await this.getOrThrow(userId, id);
    if (period.closedAt !== null) {
      throw new ClosedPeriodException('PERIOD_CLOSED');
    }
    const updated = await this.periodRepository.updateDates(userId, id, {
      startsOn: dto.startsOn ? parseDateOnly(dto.startsOn) : undefined,
      endsOn: dto.endsOn ? parseDateOnly(dto.endsOn) : undefined,
    });
    return PeriodResponseDto.from(updated);
  }

  async remove(userId: string, id: string): Promise<void> {
    const period = await this.getOrThrow(userId, id);
    if (period.closedAt !== null) {
      throw new ClosedPeriodException('PERIOD_CLOSED');
    }
    const liveCount = await this.allocationRepository.countLiveByPeriod(userId, id);
    if (liveCount > 0) {
      throw new PeriodNotEmptyException();
    }
    await this.periodRepository.softDelete(userId, id);
  }

  async closePreview(userId: string, id: string): Promise<ClosePreviewResponseDto> {
    const period = await this.getOrThrow(userId, id);
    const { blockers, nextPeriod } = await this.evaluateBlockers(userId, period);
    const categories = await this.computeCategoryActions(userId, id);
    return ClosePreviewResponseDto.from(period, nextPeriod, blockers, categories);
  }

  async close(userId: string, id: string): Promise<CloseResponseDto> {
    return this.periodRepository.runInTransaction(async (tx) => {
      const period = await this.periodRepository.lockForUpdate(tx, userId, id);
      if (!period) {
        throw new PeriodNotFoundException();
      }

      const { blockers, nextPeriod } = await this.evaluateBlockers(userId, period, tx);
      if (blockers.length > 0) {
        throw this.blockerException(blockers[0]);
      }

      const categories = await this.computeCategoryActions(userId, id);
      const note = `Arrastre del periodo ${period.startsOn.toISOString().slice(0, 10)} a ${period.endsOn.toISOString().slice(0, 10)}`;

      const carriedForward: CategoryAmountDto[] = [];
      const carriedDeficits: CategoryAmountDto[] = [];
      const released: CategoryAmountDto[] = [];

      for (const cat of categories) {
        if (cat.action === 'carry_forward') {
          await this.allocationRepository.insertTx(tx, userId, nextPeriod!.id, cat.categoryId, cat.carryCents, 'rollover', note);
          carriedForward.push({ categoryId: cat.categoryId, categoryName: cat.categoryName, amountCents: cat.carryCents });
        } else if (cat.action === 'carry_deficit') {
          await this.allocationRepository.insertTx(tx, userId, nextPeriod!.id, cat.categoryId, cat.carryCents, 'rollover', note);
          carriedDeficits.push({ categoryId: cat.categoryId, categoryName: cat.categoryName, amountCents: cat.carryCents });
        } else if (cat.action === 'release') {
          released.push({ categoryId: cat.categoryId, categoryName: cat.categoryName, amountCents: cat.availableCents });
        }
      }

      const closedPeriod = await this.periodRepository.setClosedAt(tx, id, new Date());
      return CloseResponseDto.from(closedPeriod, nextPeriod!.id, carriedForward, carriedDeficits, released);
    });
  }

  private async getOrThrow(userId: string, id: string): Promise<PeriodRow> {
    const period = await this.periodRepository.findById(userId, id);
    if (!period) {
      throw new PeriodNotFoundException();
    }
    return period;
  }

  private async evaluateBlockers(userId: string, period: PeriodRow, tx?: Prisma.TransactionClient): Promise<BlockerCheck> {
    if (period.closedAt !== null) {
      return { blockers: ['PERIOD_ALREADY_CLOSED'], nextPeriod: null };
    }
    const earlierOpen = await this.periodRepository.findEarliestOpenBefore(userId, period.startsOn, tx);
    if (earlierOpen) {
      return { blockers: ['EARLIER_PERIOD_OPEN'], nextPeriod: null };
    }
    const nextPeriod = await this.periodRepository.findNextAfter(userId, period.endsOn, tx);
    if (!nextPeriod) {
      return { blockers: ['NEXT_PERIOD_REQUIRED'], nextPeriod: null };
    }
    if (nextPeriod.closedAt !== null) {
      return { blockers: ['NEXT_PERIOD_CLOSED'], nextPeriod };
    }
    return { blockers: [], nextPeriod };
  }

  private blockerException(code: string): DomainException {
    switch (code) {
      case 'PERIOD_ALREADY_CLOSED':
        return new ClosedPeriodException('PERIOD_ALREADY_CLOSED');
      case 'EARLIER_PERIOD_OPEN':
        return new EarlierPeriodOpenException();
      case 'NEXT_PERIOD_CLOSED':
        return new ClosedPeriodException('NEXT_PERIOD_CLOSED');
      default:
        return new NextPeriodRequiredException();
    }
  }

  private async computeCategoryActions(userId: string, periodId: string): Promise<CategoryCloseActionDto[]> {
    const balances = await this.queryRepository.categoryBalances(userId, periodId);
    const accounts = await this.accountRepository.findManyByIds(userId, balances.map((b) => b.categoryId));
    const rolloverById = new Map(accounts.map((a) => [a.id, a.rolloverType]));

    return balances.map((b) => {
      const rolloverType: 'accumulate' | 'reset' = rolloverById.get(b.categoryId) === ('Accumulate' as RolloverType) ? 'accumulate' : 'reset';
      let action: CategoryCloseActionDto['action'] = 'none';
      let carryCents = 0n;
      if (b.availableCents > 0n) {
        if (rolloverType === 'accumulate') {
          action = 'carry_forward';
          carryCents = b.availableCents;
        } else {
          action = 'release';
        }
      } else if (b.availableCents < 0n) {
        action = 'carry_deficit';
        carryCents = b.availableCents;
      }
      return {
        categoryId: b.categoryId,
        categoryName: b.name,
        rolloverType,
        assignedCents: b.assignedCents,
        spentCents: b.spentCents,
        availableCents: b.availableCents,
        hasBudget: b.hasBudget,
        action,
        carryCents,
      };
    });
  }
}
