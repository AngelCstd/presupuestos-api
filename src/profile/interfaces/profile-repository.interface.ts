export interface ProfileRow {
  id: string;
  timezone: string;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface IProfileRepository {
  isValidTimezone(timezone: string): Promise<boolean>;
  updateTimezone(userId: string, timezone: string): Promise<ProfileRow>;
}
