import { IsOptional } from 'class-validator';
import { IsStrictDateString } from '../../common/validators/is-strict-date-string.validator';

export class UpdatePeriodDto {
  @IsOptional()
  @IsStrictDateString()
  startsOn?: string;

  @IsOptional()
  @IsStrictDateString()
  endsOn?: string;
}
