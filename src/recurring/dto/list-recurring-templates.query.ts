import { Transform, Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class ListRecurringTemplatesQueryDto {
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  dueOnly?: boolean;

  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  includeInactive?: boolean;

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
