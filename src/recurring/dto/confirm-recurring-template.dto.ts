import { IsOptional, IsString, IsUUID } from 'class-validator';
import { IsCentsString } from '../../common/validators/is-cents-string.validator';
import { IsPositiveCents } from '../../common/validators/is-positive-cents.validator';
import { IsStrictDateString } from '../../common/validators/is-strict-date-string.validator';

export class ConfirmRecurringTemplateDto {
  @IsOptional()
  @IsStrictDateString()
  bookedAt?: string;

  @IsOptional()
  @IsCentsString()
  @IsPositiveCents()
  amountCents?: bigint;

  @IsOptional()
  @IsUUID()
  paidFromAccountId?: string;

  @IsOptional()
  @IsString()
  description?: string;
}
