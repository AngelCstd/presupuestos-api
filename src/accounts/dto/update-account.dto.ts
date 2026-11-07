import { IsNotEmpty, IsOptional, IsString, Matches } from 'class-validator';

/** PATCH acepta `name` y `currency`. Nada más — `rolloverType` no aplica aquí (§6.5). */
export class UpdateAccountDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{3}$/)
  currency?: string;
}
