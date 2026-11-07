import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/guards/auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { CursorQueryDto } from '../common/pagination/cursor.dto';
import { AccountsService } from './accounts.service';
import { CreateAccountDto } from './dto/create-account.dto';
import { UpdateAccountDto } from './dto/update-account.dto';
import { ListAccountsQueryDto } from './dto/list-accounts.query';

@Controller('accounts')
@UseGuards(AuthGuard)
export class AccountsController {
  constructor(private readonly accountsService: AccountsService) {}

  @Get()
  findMany(@CurrentUser() user: { userId: string }, @Query() query: ListAccountsQueryDto) {
    return this.accountsService.findMany(user.userId, query);
  }

  @Post()
  create(@CurrentUser() user: { userId: string }, @Body() dto: CreateAccountDto) {
    return this.accountsService.create(user.userId, dto);
  }

  @Get(':id')
  findById(@CurrentUser() user: { userId: string }, @Param('id') id: string) {
    return this.accountsService.findById(user.userId, id);
  }

  @Patch(':id')
  update(@CurrentUser() user: { userId: string }, @Param('id') id: string, @Body() dto: UpdateAccountDto) {
    return this.accountsService.update(user.userId, id, dto);
  }

  @Post(':id/archive')
  @HttpCode(200)
  archive(@CurrentUser() user: { userId: string }, @Param('id') id: string) {
    return this.accountsService.archive(user.userId, id);
  }

  @Post(':id/unarchive')
  @HttpCode(200)
  unarchive(@CurrentUser() user: { userId: string }, @Param('id') id: string) {
    return this.accountsService.unarchive(user.userId, id);
  }

  @Get(':id/ledger')
  ledger(@CurrentUser() user: { userId: string }, @Param('id') id: string, @Query() query: CursorQueryDto) {
    return this.accountsService.ledger(user.userId, id, query.cursor, query.limit);
  }
}
