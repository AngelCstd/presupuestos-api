import { IsUUID } from 'class-validator';

export class CategoryBalancesQueryDto {
  @IsUUID()
  periodId!: string;
}
