import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class UpdateIncomeSourceDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;
}
