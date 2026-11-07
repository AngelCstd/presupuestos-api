import { IsNotEmpty, IsString } from 'class-validator';

/** T-F11 — solo `description`. `forbidNonWhitelisted` rechaza `bookedAt` antes de llegar a R6. */
export class UpdateTransactionDto {
  @IsString()
  @IsNotEmpty()
  description!: string;
}
