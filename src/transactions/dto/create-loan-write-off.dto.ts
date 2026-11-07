import { IsNotEmpty, IsString, IsUUID } from 'class-validator';
import { IsCentsString } from '../../common/validators/is-cents-string.validator';
import { IsPositiveCents } from '../../common/validators/is-positive-cents.validator';
import { IsStrictDateString } from '../../common/validators/is-strict-date-string.validator';

export class CreateLoanWriteOffDto {
  @IsStrictDateString()
  bookedAt!: string;

  @IsString()
  @IsNotEmpty()
  description!: string;

  @IsUUID()
  receivableAccountId!: string;

  @IsUUID()
  categoryId!: string;

  @IsCentsString()
  @IsPositiveCents()
  amountCents!: bigint;
}
