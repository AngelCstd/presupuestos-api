import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsNotEmpty, IsOptional, IsString, IsUUID, ValidateNested } from 'class-validator';
import { IsCentsString } from '../../common/validators/is-cents-string.validator';
import { IsPositiveCents } from '../../common/validators/is-positive-cents.validator';
import { IsStrictDateString } from '../../common/validators/is-strict-date-string.validator';

export class ExpenseLineDto {
  @IsUUID()
  categoryId!: string;

  @IsCentsString()
  @IsPositiveCents()
  amountCents!: bigint;
}

export class LentToLineDto {
  @IsUUID()
  receivableAccountId!: string;

  @IsCentsString()
  @IsPositiveCents()
  amountCents!: bigint;
}

export class CreateExpenseDto {
  @IsStrictDateString()
  bookedAt!: string;

  @IsString()
  @IsNotEmpty()
  description!: string;

  @IsUUID()
  paidFromAccountId!: string;

  @IsCentsString()
  @IsPositiveCents()
  totalCents!: bigint;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ExpenseLineDto)
  lines!: ExpenseLineDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => LentToLineDto)
  lentTo?: LentToLineDto[];
}
