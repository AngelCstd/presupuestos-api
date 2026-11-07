import { Inject, Injectable } from '@nestjs/common';
import type { IProfileRepository, ProfileRow } from './interfaces/profile-repository.interface';
import { InvalidTimezoneException } from './exceptions/invalid-timezone.exception';

@Injectable()
export class ProfileService {
  constructor(@Inject('IProfileRepository') private readonly profileRepository: IProfileRepository) {}

  async updateTimezone(userId: string, timezone: string): Promise<ProfileRow> {
    const isValid = await this.profileRepository.isValidTimezone(timezone);
    if (!isValid) {
      throw new InvalidTimezoneException();
    }
    return this.profileRepository.updateTimezone(userId, timezone);
  }
}
