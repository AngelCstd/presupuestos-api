import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';
import { IsStrictDateString } from '../../common/validators/is-strict-date-string.validator';

export class ListTransactionsQueryDto {
  @IsOptional()
  @IsStrictDateString()
  from?: string;

  @IsOptional()
  @IsStrictDateString()
  to?: string;

  @IsOptional()
  @IsUUID()
  accountId?: string;

  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 50;

  @IsOptional()
  @IsString()
  cursor?: string;
}
