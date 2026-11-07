export class UnassignedFundsResponseDto {
  unassignedCents!: bigint;

  static from(unassignedCents: bigint): UnassignedFundsResponseDto {
    const dto = new UnassignedFundsResponseDto();
    dto.unassignedCents = unassignedCents;
    return dto;
  }
}
