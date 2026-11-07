import { IsBoolean, IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';
import { IsCentsString } from '../../common/validators/is-cents-string.validator';
import { IsPositiveCents } from '../../common/validators/is-positive-cents.validator';

export class UpdateRecurringTemplateDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @IsOptional()
  @IsUUID()
  accountId?: string;

  @IsOptional()
  @IsCentsString()
  @IsPositiveCents()
  amountCents?: bigint;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(31)
  dayOfMonth?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
