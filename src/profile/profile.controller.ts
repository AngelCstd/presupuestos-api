import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/guards/auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { CurrentProfile } from '../common/decorators/current-profile.decorator';
import { ProfileService } from './profile.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ProfileResponseDto } from './dto/profile-response.dto';
import type { ProfileRow } from './interfaces/profile-repository.interface';

@Controller('me')
export class ProfileController {
  constructor(private readonly profileService: ProfileService) {}

  @Get()
  @UseGuards(AuthGuard)
  getMe(
    @CurrentUser() user: { userId: string; email: string },
    @CurrentProfile() profile: ProfileRow,
  ): ProfileResponseDto {
    return ProfileResponseDto.from(user, profile);
  }

  @Patch()
  @UseGuards(AuthGuard)
  async updateMe(
    @CurrentUser() user: { userId: string; email: string },
    @Body() dto: UpdateProfileDto,
  ): Promise<ProfileResponseDto> {
    const profile = await this.profileService.updateTimezone(user.userId, dto.timezone);
    return ProfileResponseDto.from(user, profile);
  }
}
