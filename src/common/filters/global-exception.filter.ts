import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import type { Response } from 'express';
import { ErrorLogRepository } from '../logging/error-log.repository';
import { DomainException } from '../errors/domain.exception';
import { ProfileDeletedException } from '../../auth/exceptions/profile-deleted.exception';

interface RequestWithUser {
  url?: string;
  user?: { userId: string };
}

const STATUS_FALLBACK_CODE: Partial<Record<number, string>> = {
  [HttpStatus.BAD_REQUEST]: 'BAD_REQUEST',
  [HttpStatus.UNAUTHORIZED]: 'UNAUTHORIZED',
  [HttpStatus.FORBIDDEN]: 'FORBIDDEN',
  [HttpStatus.NOT_FOUND]: 'NOT_FOUND',
  [HttpStatus.CONFLICT]: 'CONFLICT',
  [HttpStatus.UNPROCESSABLE_ENTITY]: 'UNPROCESSABLE_ENTITY',
};

/**
 * TASK-auth.md, Entregables: "formato de error consistente, nunca expone
 * stack trace, escribe en ErrorLog best-effort". El fallo de escritura del
 * log (T-10) se traga a propósito — jamás debe cambiar la respuesta al
 * cliente.
 *
 * TASK-api.md §5.3 agrega el campo `code`: sale de `DomainException.code`
 * si la excepción extiende esa clase; si el cuerpo de una `HttpException`
 * ya trae un `code` embebido (caso de `ValidationPipe`, ver
 * `_helpers/app.ts`), se usa tal cual; si no, se deriva del status.
 *
 * `timestamp`/`path` no estaban en la versión de TASK-auth — hueco real
 * de esa implementación, no una adición nueva de esta capa. Se agregan
 * aquí porque es la única pieza que esta tarea toca de este archivo.
 */
@Injectable()
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  constructor(private readonly errorLogRepository: ErrorLogRepository) {}

  async catch(exception: unknown, host: ArgumentsHost): Promise<void> {
    const response = host.switchToHttp().getResponse<Response>();
    const request = host.switchToHttp().getRequest<RequestWithUser>();

    const isHttpException = exception instanceof HttpException;
    const status = isHttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const body = isHttpException ? exception.getResponse() : null;

    const code = this.deriveCode(exception, status, body);
    const message = this.deriveMessage(exception, body);
    const details =
      body !== null && typeof body === 'object' && 'details' in body
        ? (body as { details: unknown }).details
        : undefined;

    const error = exception instanceof Error ? exception : new Error(String(exception));

    try {
      await this.errorLogRepository.write({
        message: error.message,
        stack: error.stack ?? null,
        context: request.url ?? null,
        userId: request.user?.userId ?? null,
        metadata: null,
      });
    } catch {
      // best-effort — un fallo al registrar el error nunca debe afectar
      // la respuesta al cliente.
    }

    const payload: Record<string, unknown> = {
      statusCode: status,
      code,
      message,
      timestamp: new Date().toISOString(),
      path: request.url ?? '',
    };
    if (details !== undefined) {
      payload.details = details;
    }

    response.status(status).json(payload);
  }

  private deriveCode(exception: unknown, status: number, body: string | object | null): string {
    if (exception instanceof DomainException) {
      return exception.code;
    }
    // Forma fijada de TASK-auth (§13 de TASK-api.md: intocable) — extiende
    // ForbiddenException, no DomainException, así que nunca tendrá `.code`
    // propio. TASK-api.md §9.3 pide igual el mapeo a PROFILE_DELETED.
    if (exception instanceof ProfileDeletedException) {
      return 'PROFILE_DELETED';
    }
    if (body !== null && typeof body === 'object' && typeof (body as { code?: unknown }).code === 'string') {
      return (body as { code: string }).code;
    }
    return STATUS_FALLBACK_CODE[status] ?? 'INTERNAL_ERROR';
  }

  private deriveMessage(exception: unknown, body: string | object | null): string {
    if (body === null) {
      return 'Error interno del servidor';
    }
    if (typeof body === 'string') {
      return body;
    }
    const bodyMessage = (body as { message?: unknown }).message;
    if (typeof bodyMessage === 'string') {
      return bodyMessage;
    }
    return exception instanceof Error ? exception.message : 'Error interno del servidor';
  }
}
