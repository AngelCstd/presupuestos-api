import { IsOptional, IsUUID } from 'class-validator';

export class DashboardQueryDto {
  @IsOptional()
  @IsUUID()
  periodId?: string;
}
