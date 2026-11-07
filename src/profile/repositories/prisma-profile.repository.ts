import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import type { IProfileRepository, ProfileRow } from '../interfaces/profile-repository.interface';

@Injectable()
export class PrismaProfileRepository implements IProfileRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /** TASK-api.md §6.4 — se valida contra la lista IANA real, no un string arbitrario. */
  async isValidTimezone(timezone: string): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<Array<{ exists: boolean }>>`
      SELECT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name = ${timezone}) AS exists
    `;
    return rows[0]?.exists ?? false;
  }

  async updateTimezone(userId: string, timezone: string): Promise<ProfileRow> {
    return this.prisma.profile.update({ where: { id: userId }, data: { timezone } });
  }
}
