import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/guards/auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AllocationsService } from './allocations.service';
import { CreateAllocationDto } from './dto/create-allocation.dto';
import { SetAllocationDto } from './dto/set-allocation.dto';
import { MoveAllocationDto } from './dto/move-allocation.dto';

interface AuthedUser {
  userId: string;
  email: string;
}

@Controller('periods/:periodId/allocations')
@UseGuards(AuthGuard)
export class AllocationsController {
  constructor(private readonly allocationsService: AllocationsService) {}

  @Get()
  findMany(@CurrentUser() user: AuthedUser, @Param('periodId') periodId: string) {
    return this.allocationsService.findMany(user.userId, periodId);
  }

  @Post()
  create(@CurrentUser() user: AuthedUser, @Param('periodId') periodId: string, @Body() dto: CreateAllocationDto) {
    return this.allocationsService.create(user.userId, periodId, dto);
  }

  @Post('move')
  @HttpCode(200)
  move(@CurrentUser() user: AuthedUser, @Param('periodId') periodId: string, @Body() dto: MoveAllocationDto) {
    return this.allocationsService.move(user.userId, periodId, dto);
  }

  @Put(':categoryId')
  setTarget(
    @CurrentUser() user: AuthedUser,
    @Param('periodId') periodId: string,
    @Param('categoryId') categoryId: string,
    @Body() dto: SetAllocationDto,
  ) {
    return this.allocationsService.setTarget(user.userId, periodId, categoryId, dto);
  }

  @Delete(':allocationId')
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthedUser, @Param('periodId') periodId: string, @Param('allocationId') allocationId: string) {
    await this.allocationsService.remove(user.userId, periodId, allocationId);
  }
}
