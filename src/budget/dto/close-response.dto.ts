import type { PeriodRow } from '../../shared/periods-data/types';
import { PeriodResponseDto } from '../../shared/periods-data/dto/period-response.dto';

export interface CategoryAmountDto {
  categoryId: string;
  categoryName: string;
  amountCents: bigint;
}

export class CloseResponseDto {
  period!: PeriodResponseDto;
  nextPeriodId!: string;
  carriedForward!: CategoryAmountDto[];
  carriedDeficits!: CategoryAmountDto[];
  released!: CategoryAmountDto[];

  static from(
    period: PeriodRow,
    nextPeriodId: string,
    carriedForward: CategoryAmountDto[],
    carriedDeficits: CategoryAmountDto[],
    released: CategoryAmountDto[],
  ): CloseResponseDto {
    const dto = new CloseResponseDto();
    dto.period = PeriodResponseDto.from(period);
    dto.nextPeriodId = nextPeriodId;
    dto.carriedForward = carriedForward;
    dto.carriedDeficits = carriedDeficits;
    dto.released = released;
    return dto;
  }
}
