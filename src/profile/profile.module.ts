import { Module } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { AuthModule } from '../auth/auth.module';
import { ProfileController } from './profile.controller';
import { ProfileService } from './profile.service';
import { PrismaProfileRepository } from './repositories/prisma-profile.repository';

@Module({
  imports: [AuthModule],
  controllers: [ProfileController],
  providers: [
    ProfileService,
    { provide: 'IProfileRepository', useClass: PrismaProfileRepository },
    { provide: PrismaClient, useValue: new PrismaClient() },
  ],
})
export class ProfileModule {}
