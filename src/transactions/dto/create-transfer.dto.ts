import { IsNotEmpty, IsString, IsUUID } from 'class-validator';
import { IsCentsString } from '../../common/validators/is-cents-string.validator';
import { IsPositiveCents } from '../../common/validators/is-positive-cents.validator';
import { IsStrictDateString } from '../../common/validators/is-strict-date-string.validator';

export class CreateTransferDto {
  @IsStrictDateString()
  bookedAt!: string;

  @IsString()
  @IsNotEmpty()
  description!: string;

  @IsUUID()
  fromAccountId!: string;

  @IsUUID()
  toAccountId!: string;

  @IsCentsString()
  @IsPositiveCents()
  amountCents!: bigint;
}
