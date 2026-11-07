import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { IsOptional, IsUUID } from 'class-validator';
import { AuthGuard } from '../auth/guards/auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { CursorQueryDto } from '../common/pagination/cursor.dto';
import { CategoriesService } from './categories.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { ListCategoriesQueryDto } from './dto/list-categories.query';

class CategoryDetailQueryDto {
  @IsOptional()
  @IsUUID()
  periodId?: string;
}

@Controller('categories')
@UseGuards(AuthGuard)
export class CategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  @Get()
  findMany(@CurrentUser() user: { userId: string }, @Query() query: ListCategoriesQueryDto) {
    return this.categoriesService.findMany(user.userId, query);
  }

  @Post()
  create(@CurrentUser() user: { userId: string }, @Body() dto: CreateCategoryDto) {
    return this.categoriesService.create(user.userId, dto);
  }

  @Get(':id')
  findById(@CurrentUser() user: { userId: string }, @Param('id') id: string, @Query() query: CategoryDetailQueryDto) {
    return this.categoriesService.findById(user.userId, id, query.periodId);
  }

  @Patch(':id')
  update(@CurrentUser() user: { userId: string }, @Param('id') id: string, @Body() dto: UpdateCategoryDto) {
    return this.categoriesService.update(user.userId, id, dto);
  }

  @Post(':id/archive')
  @HttpCode(200)
  archive(@CurrentUser() user: { userId: string }, @Param('id') id: string) {
    return this.categoriesService.archive(user.userId, id);
  }

  @Post(':id/unarchive')
  @HttpCode(200)
  unarchive(@CurrentUser() user: { userId: string }, @Param('id') id: string) {
    return this.categoriesService.unarchive(user.userId, id);
  }

  @Get(':id/ledger')
  ledger(@CurrentUser() user: { userId: string }, @Param('id') id: string, @Query() query: CursorQueryDto) {
    return this.categoriesService.ledger(user.userId, id, query.cursor, query.limit);
  }
}
