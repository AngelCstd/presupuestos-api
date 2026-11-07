import { IsNotEmpty, IsString, IsUUID } from 'class-validator';
import { IsCentsString } from '../../common/validators/is-cents-string.validator';
import { IsPositiveCents } from '../../common/validators/is-positive-cents.validator';
import { IsStrictDateString } from '../../common/validators/is-strict-date-string.validator';

export class CreateIncomeDto {
  @IsStrictDateString()
  bookedAt!: string;

  @IsString()
  @IsNotEmpty()
  description!: string;

  @IsUUID()
  toAccountId!: string;

  @IsUUID()
  sourceId!: string;

  @IsCentsString()
  @IsPositiveCents()
  amountCents!: bigint;
}
