import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsOptional, IsString, IsUUID, ValidateNested } from 'class-validator';
import { IsCentsString } from '../../common/validators/is-cents-string.validator';
import { IsStrictDateString } from '../../common/validators/is-strict-date-string.validator';

export class OpeningBalanceLineDto {
  @IsUUID()
  accountId!: string;

  /** Con signo — TASK-api.md §4.7: cash/receivable positivos, deuda de tarjeta negativo. */
  @IsCentsString()
  balanceCents!: bigint;
}

export class CreateOpeningBalanceDto {
  @IsStrictDateString()
  bookedAt!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => OpeningBalanceLineDto)
  balances!: OpeningBalanceLineDto[];
}
