import { IsIn, IsNotEmpty, IsOptional, IsString, Matches } from 'class-validator';

export class CreateAccountDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsIn(['cash', 'credit', 'receivable'])
  kind!: 'cash' | 'credit' | 'receivable';

  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{3}$/)
  currency?: string;
}
