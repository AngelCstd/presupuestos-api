import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { AuthGuard } from '../auth/guards/auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { CurrentProfile } from '../common/decorators/current-profile.decorator';
import { IdempotencyKey } from '../common/decorators/idempotency-key.decorator';
import { RecurringService } from './recurring.service';
import { CreateRecurringTemplateDto } from './dto/create-recurring-template.dto';
import { UpdateRecurringTemplateDto } from './dto/update-recurring-template.dto';
import { ConfirmRecurringTemplateDto } from './dto/confirm-recurring-template.dto';
import { ListRecurringTemplatesQueryDto } from './dto/list-recurring-templates.query';

interface AuthedUser {
  userId: string;
  email: string;
}
interface Profile {
  timezone: string;
}

@Controller('recurring-templates')
@UseGuards(AuthGuard)
export class RecurringController {
  constructor(private readonly recurringService: RecurringService) {}

  @Get()
  findMany(@CurrentUser() user: AuthedUser, @CurrentProfile() profile: Profile, @Query() query: ListRecurringTemplatesQueryDto) {
    return this.recurringService.findMany(user.userId, profile.timezone, query);
  }

  @Post()
  create(@CurrentUser() user: AuthedUser, @CurrentProfile() profile: Profile, @Body() dto: CreateRecurringTemplateDto) {
    return this.recurringService.create(user.userId, profile.timezone, dto);
  }

  @Get(':id')
  findById(@CurrentUser() user: AuthedUser, @CurrentProfile() profile: Profile, @Param('id') id: string) {
    return this.recurringService.findById(user.userId, profile.timezone, id);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthedUser,
    @CurrentProfile() profile: Profile,
    @Param('id') id: string,
    @Body() dto: UpdateRecurringTemplateDto,
  ) {
    return this.recurringService.update(user.userId, profile.timezone, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthedUser, @Param('id') id: string) {
    await this.recurringService.remove(user.userId, id);
  }

  @Post(':id/confirm')
  async confirm(
    @CurrentUser() user: AuthedUser,
    @CurrentProfile() profile: Profile,
    @Param('id') id: string,
    @Body() dto: ConfirmRecurringTemplateDto,
    @IdempotencyKey() idempotencyKey: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { transaction, template, created } = await this.recurringService.confirm(user.userId, profile.timezone, id, dto, idempotencyKey);
    res.status(created ? 201 : 200);
    return { transaction, template };
  }
}
