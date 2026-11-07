import type { PeriodRow } from '../types';

export class PeriodResponseDto {
  id!: string;
  startsOn!: string;
  endsOn!: string;
  status!: 'open' | 'closed';
  closedAt!: string | null;
  createdAt!: string;
  updatedAt!: string;

  static from(period: PeriodRow): PeriodResponseDto {
    const dto = new PeriodResponseDto();
    dto.id = period.id;
    dto.startsOn = period.startsOn.toISOString().slice(0, 10);
    dto.endsOn = period.endsOn.toISOString().slice(0, 10);
    dto.status = period.closedAt ? 'closed' : 'open';
    dto.closedAt = period.closedAt ? period.closedAt.toISOString() : null;
    dto.createdAt = period.createdAt.toISOString();
    dto.updatedAt = period.updatedAt.toISOString();
    return dto;
  }
}
