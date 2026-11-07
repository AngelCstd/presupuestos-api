import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/guards/auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { CurrentProfile } from '../common/decorators/current-profile.decorator';
import { PeriodsService } from './periods.service';
import { CreatePeriodDto } from './dto/create-period.dto';
import { UpdatePeriodDto } from './dto/update-period.dto';
import { ListPeriodsQueryDto } from './dto/list-periods.query';

interface AuthedUser {
  userId: string;
  email: string;
}
interface Profile {
  timezone: string;
}

@Controller('periods')
@UseGuards(AuthGuard)
export class PeriodsController {
  constructor(private readonly periodsService: PeriodsService) {}

  @Get()
  findMany(@CurrentUser() user: AuthedUser, @Query() query: ListPeriodsQueryDto) {
    return this.periodsService.findMany(user.userId, query);
  }

  @Get('current')
  findCurrent(@CurrentUser() user: AuthedUser, @CurrentProfile() profile: Profile) {
    return this.periodsService.findCurrent(user.userId, profile.timezone);
  }

  @Post()
  create(@CurrentUser() user: AuthedUser, @Body() dto: CreatePeriodDto) {
    return this.periodsService.create(user.userId, dto);
  }

  @Get(':id')
  findById(@CurrentUser() user: AuthedUser, @Param('id') id: string) {
    return this.periodsService.findById(user.userId, id);
  }

  @Patch(':id')
  update(@CurrentUser() user: AuthedUser, @Param('id') id: string, @Body() dto: UpdatePeriodDto) {
    return this.periodsService.update(user.userId, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthedUser, @Param('id') id: string) {
    await this.periodsService.remove(user.userId, id);
  }

  @Get(':id/close-preview')
  closePreview(@CurrentUser() user: AuthedUser, @Param('id') id: string) {
    return this.periodsService.closePreview(user.userId, id);
  }

  @Post(':id/close')
  @HttpCode(200)
  close(@CurrentUser() user: AuthedUser, @Param('id') id: string) {
    return this.periodsService.close(user.userId, id);
  }
}
