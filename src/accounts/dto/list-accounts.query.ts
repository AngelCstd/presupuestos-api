import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

export class ListAccountsQueryDto {
  @IsOptional()
  @IsIn(['cash', 'credit', 'receivable'])
  kind?: 'cash' | 'credit' | 'receivable';

  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  includeArchived: boolean = false;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  pageSize: number = 50;
}
