import { IsOptional, IsString } from 'class-validator';
import { IsStrictDateString } from '../../common/validators/is-strict-date-string.validator';

export class CreateReversalDto {
  @IsOptional()
  @IsStrictDateString()
  bookedAt?: string;

  @IsOptional()
  @IsString()
  description?: string;
}
