import { IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class UpdateCategoryDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsIn(['accumulate', 'reset'])
  rolloverType?: 'accumulate' | 'reset';
}
