import { IsNotEmpty, IsOptional, IsString, Matches } from 'class-validator';

export class CreateIncomeSourceDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{3}$/)
  currency?: string;
}
