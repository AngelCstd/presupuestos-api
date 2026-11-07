import { IsUUID } from 'class-validator';
import { IsCentsString } from '../../common/validators/is-cents-string.validator';
import { IsPositiveCents } from '../../common/validators/is-positive-cents.validator';

export class MoveAllocationDto {
  @IsUUID()
  fromCategoryId!: string;

  @IsUUID()
  toCategoryId!: string;

  @IsCentsString()
  @IsPositiveCents()
  amountCents!: bigint;
}
