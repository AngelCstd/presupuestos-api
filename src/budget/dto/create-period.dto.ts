import { IsStrictDateString } from '../../common/validators/is-strict-date-string.validator';

export class CreatePeriodDto {
  @IsStrictDateString()
  startsOn!: string;

  @IsStrictDateString()
  endsOn!: string;
}
