import { Transform, Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

export class ListCategoriesQueryDto {
  @IsOptional()
  @IsUUID()
  periodId?: string;

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
