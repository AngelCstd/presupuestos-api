import { IsOptional, IsString, IsUUID } from 'class-validator';
import { IsCentsString } from '../../common/validators/is-cents-string.validator';
import { IsNonZeroCents } from '../../common/validators/is-nonzero-cents.validator';

export class CreateAllocationDto {
  @IsUUID()
  categoryId!: string;

  @IsCentsString()
  @IsNonZeroCents()
  amountCents!: bigint;

  @IsOptional()
  @IsString()
  note?: string;
}
