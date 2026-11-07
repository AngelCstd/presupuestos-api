import { IsIn, IsNotEmpty, IsOptional, IsString, Matches } from 'class-validator';

export class CreateCategoryDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsIn(['accumulate', 'reset'])
  rolloverType!: 'accumulate' | 'reset';

  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{3}$/)
  currency?: string;
}
