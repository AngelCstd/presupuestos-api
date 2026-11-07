import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * TASK-api.md §9.1/§5.3: toda excepción de dominio extiende esta clase,
 * que lleva `code` (usado tal cual por GlobalExceptionFilter) y el
 * status HTTP (heredado de HttpException, vía `getStatus()`).
 */
export abstract class DomainException extends HttpException {
  constructor(
    readonly code: string,
    status: HttpStatus,
    message: string,
  ) {
    super(message, status);
  }
}
