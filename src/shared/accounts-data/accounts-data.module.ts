import { Module } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaAccountRepository } from './repositories/prisma-account.repository';

@Module({
  providers: [
    { provide: 'IAccountRepository', useClass: PrismaAccountRepository },
    { provide: PrismaClient, useValue: new PrismaClient() },
  ],
  exports: ['IAccountRepository'],
})
export class AccountsDataModule {}
