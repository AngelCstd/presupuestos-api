import { Module } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaTransactionRepository } from './repositories/prisma-transaction.repository';

@Module({
  providers: [
    { provide: 'ITransactionRepository', useClass: PrismaTransactionRepository },
    { provide: PrismaClient, useValue: new PrismaClient() },
  ],
  exports: ['ITransactionRepository'],
})
export class LedgerModule {}
