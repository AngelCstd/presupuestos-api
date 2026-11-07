import { IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';
import { IsCentsString } from '../../common/validators/is-cents-string.validator';
import { IsPositiveCents } from '../../common/validators/is-positive-cents.validator';
import { IsStrictDateString } from '../../common/validators/is-strict-date-string.validator';

export class CreateRecurringTemplateDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsUUID()
  categoryId!: string;

  @IsOptional()
  @IsUUID()
  accountId?: string;

  @IsCentsString()
  @IsPositiveCents()
  amountCents!: bigint;

  @IsInt()
  @Min(1)
  @Max(31)
  dayOfMonth!: number;

  @IsOptional()
  @IsStrictDateString()
  nextDueOn?: string;
}
