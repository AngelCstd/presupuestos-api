import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { Transform, Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { AuthGuard } from '../auth/guards/auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { IncomeSourcesService } from './income-sources.service';
import { CreateIncomeSourceDto } from './dto/create-income-source.dto';
import { UpdateIncomeSourceDto } from './dto/update-income-source.dto';

class ListIncomeSourcesQueryDto {
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  includeArchived: boolean = false;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  pageSize: number = 50;
}

@Controller('income-sources')
@UseGuards(AuthGuard)
export class IncomeSourcesController {
  constructor(private readonly incomeSourcesService: IncomeSourcesService) {}

  @Get()
  findMany(@CurrentUser() user: { userId: string }, @Query() query: ListIncomeSourcesQueryDto) {
    return this.incomeSourcesService.findMany(user.userId, query);
  }

  @Post()
  create(@CurrentUser() user: { userId: string }, @Body() dto: CreateIncomeSourceDto) {
    return this.incomeSourcesService.create(user.userId, dto);
  }

  @Get(':id')
  findById(@CurrentUser() user: { userId: string }, @Param('id') id: string) {
    return this.incomeSourcesService.findById(user.userId, id);
  }

  @Patch(':id')
  update(@CurrentUser() user: { userId: string }, @Param('id') id: string, @Body() dto: UpdateIncomeSourceDto) {
    return this.incomeSourcesService.update(user.userId, id, dto);
  }

  @Post(':id/archive')
  @HttpCode(200)
  archive(@CurrentUser() user: { userId: string }, @Param('id') id: string) {
    return this.incomeSourcesService.archive(user.userId, id);
  }

  @Post(':id/unarchive')
  @HttpCode(200)
  unarchive(@CurrentUser() user: { userId: string }, @Param('id') id: string) {
    return this.incomeSourcesService.unarchive(user.userId, id);
  }
}
