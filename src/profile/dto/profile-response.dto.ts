import type { ProfileRow } from '../interfaces/profile-repository.interface';

export class ProfileResponseDto {
  userId!: string;
  email!: string;
  timezone!: string;
  createdAt!: string;
  updatedAt!: string;

  static from(user: { userId: string; email: string }, profile: ProfileRow): ProfileResponseDto {
    const dto = new ProfileResponseDto();
    dto.userId = user.userId;
    dto.email = user.email;
    dto.timezone = profile.timezone;
    dto.createdAt = profile.createdAt.toISOString();
    dto.updatedAt = profile.updatedAt.toISOString();
    return dto;
  }
}
