import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/guards/auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { CurrentProfile } from '../common/decorators/current-profile.decorator';
import { InsightsService } from './insights.service';
import { CategoryBalancesQueryDto } from './dto/category-balances.query';
import { DashboardQueryDto } from './dto/dashboard.query';

interface AuthedUser {
  userId: string;
  email: string;
}
interface Profile {
  timezone: string;
}

@Controller('insights')
@UseGuards(AuthGuard)
export class InsightsController {
  constructor(private readonly insightsService: InsightsService) {}

  @Get('account-balances')
  accountBalances(@CurrentUser() user: AuthedUser) {
    return this.insightsService.accountBalances(user.userId);
  }

  @Get('category-balances')
  categoryBalances(@CurrentUser() user: AuthedUser, @Query() query: CategoryBalancesQueryDto) {
    return this.insightsService.categoryBalances(user.userId, query.periodId);
  }

  @Get('unassigned-funds')
  unassignedFunds(@CurrentUser() user: AuthedUser) {
    return this.insightsService.unassignedFunds(user.userId);
  }

  @Get('unbudgeted-transactions')
  unbudgetedTransactions(@CurrentUser() user: AuthedUser) {
    return this.insightsService.unbudgetedTransactions(user.userId);
  }

  @Get('dashboard')
  dashboard(@CurrentUser() user: AuthedUser, @CurrentProfile() profile: Profile, @Query() query: DashboardQueryDto) {
    return this.insightsService.dashboard(user.userId, profile.timezone, query.periodId);
  }
}
