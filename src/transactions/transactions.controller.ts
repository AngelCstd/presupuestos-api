import { Body, Controller, Get, Param, Patch, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { AuthGuard } from '../auth/guards/auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { CurrentProfile } from '../common/decorators/current-profile.decorator';
import { IdempotencyKey } from '../common/decorators/idempotency-key.decorator';
import { TransactionsService } from './transactions.service';
import { CreateExpenseDto } from './dto/create-expense.dto';
import { CreateIncomeDto } from './dto/create-income.dto';
import { CreateTransferDto } from './dto/create-transfer.dto';
import { CreateLoanDto } from './dto/create-loan.dto';
import { CreateLoanRepaymentDto } from './dto/create-loan-repayment.dto';
import { CreateLoanWriteOffDto } from './dto/create-loan-write-off.dto';
import { CreateOpeningBalanceDto } from './dto/create-opening-balance.dto';
import { CreateReversalDto } from './dto/create-reversal.dto';
import { UpdateTransactionDto } from './dto/update-transaction.dto';
import { ListTransactionsQueryDto } from './dto/list-transactions.query';

interface AuthedUser {
  userId: string;
  email: string;
}
interface Profile {
  timezone: string;
}

@Controller('transactions')
@UseGuards(AuthGuard)
export class TransactionsController {
  constructor(private readonly transactionsService: TransactionsService) {}

  @Post('expenses')
  async createExpense(
    @CurrentUser() user: AuthedUser,
    @CurrentProfile() profile: Profile,
    @Body() dto: CreateExpenseDto,
    @IdempotencyKey() idempotencyKey: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { dto: body, created } = await this.transactionsService.createExpense(user.userId, profile.timezone, dto, idempotencyKey);
    res.status(created ? 201 : 200);
    return body;
  }

  @Post('incomes')
  async createIncome(
    @CurrentUser() user: AuthedUser,
    @CurrentProfile() profile: Profile,
    @Body() dto: CreateIncomeDto,
    @IdempotencyKey() idempotencyKey: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { dto: body, created } = await this.transactionsService.createIncome(user.userId, profile.timezone, dto, idempotencyKey);
    res.status(created ? 201 : 200);
    return body;
  }

  @Post('transfers')
  async createTransfer(
    @CurrentUser() user: AuthedUser,
    @CurrentProfile() profile: Profile,
    @Body() dto: CreateTransferDto,
    @IdempotencyKey() idempotencyKey: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { dto: body, created } = await this.transactionsService.createTransfer(user.userId, profile.timezone, dto, idempotencyKey);
    res.status(created ? 201 : 200);
    return body;
  }

  @Post('loans')
  async createLoan(
    @CurrentUser() user: AuthedUser,
    @CurrentProfile() profile: Profile,
    @Body() dto: CreateLoanDto,
    @IdempotencyKey() idempotencyKey: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { dto: body, created } = await this.transactionsService.createLoan(user.userId, profile.timezone, dto, idempotencyKey);
    res.status(created ? 201 : 200);
    return body;
  }

  @Post('loan-repayments')
  async createLoanRepayment(
    @CurrentUser() user: AuthedUser,
    @CurrentProfile() profile: Profile,
    @Body() dto: CreateLoanRepaymentDto,
    @IdempotencyKey() idempotencyKey: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { dto: body, created } = await this.transactionsService.createLoanRepayment(user.userId, profile.timezone, dto, idempotencyKey);
    res.status(created ? 201 : 200);
    return body;
  }

  @Post('loan-write-offs')
  async createLoanWriteOff(
    @CurrentUser() user: AuthedUser,
    @CurrentProfile() profile: Profile,
    @Body() dto: CreateLoanWriteOffDto,
    @IdempotencyKey() idempotencyKey: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { dto: body, created } = await this.transactionsService.createLoanWriteOff(user.userId, profile.timezone, dto, idempotencyKey);
    res.status(created ? 201 : 200);
    return body;
  }

  @Post('opening-balances')
  async createOpeningBalance(
    @CurrentUser() user: AuthedUser,
    @CurrentProfile() profile: Profile,
    @Body() dto: CreateOpeningBalanceDto,
    @IdempotencyKey() idempotencyKey: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { dto: body, created } = await this.transactionsService.createOpeningBalance(user.userId, profile.timezone, dto, idempotencyKey);
    res.status(created ? 201 : 200);
    return body;
  }

  @Post(':id/reversal')
  async createReversal(
    @CurrentUser() user: AuthedUser,
    @CurrentProfile() profile: Profile,
    @Param('id') id: string,
    @Body() dto: CreateReversalDto,
    @IdempotencyKey() idempotencyKey: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { dto: body, created } = await this.transactionsService.createReversal(user.userId, profile.timezone, id, dto, idempotencyKey);
    res.status(created ? 201 : 200);
    return body;
  }

  @Get()
  findMany(@CurrentUser() user: AuthedUser, @Query() query: ListTransactionsQueryDto) {
    return this.transactionsService.findMany(user.userId, query);
  }

  @Get(':id')
  findById(@CurrentUser() user: AuthedUser, @Param('id') id: string) {
    return this.transactionsService.findById(user.userId, id);
  }

  @Patch(':id')
  update(@CurrentUser() user: AuthedUser, @Param('id') id: string, @Body() dto: UpdateTransactionDto) {
    return this.transactionsService.updateDescription(user.userId, id, dto);
  }
}
