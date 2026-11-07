import { IsCentsString } from '../../common/validators/is-cents-string.validator';

export class SetAllocationDto {
  @IsCentsString()
  targetAssignedCents!: bigint;
}
