export interface PeriodRow {
  id: string;
  userId: string;
  startsOn: Date;
  endsOn: Date;
  closedAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreatePeriodData {
  startsOn: Date;
  endsOn: Date;
}

export interface UpdatePeriodDatesData {
  startsOn?: Date;
  endsOn?: Date;
}
