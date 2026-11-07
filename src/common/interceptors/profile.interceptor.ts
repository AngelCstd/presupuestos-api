import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, from, switchMap } from 'rxjs';
import type { Request } from 'express';
import { EnsureProfileExistsService } from '../../auth/services/ensure-profile-exists.service';

interface RequestWithUser extends Request {
  user?: { userId: string; email: string };
  profile?: unknown;
}

/**
 * TASK-api.md §5.7 — corre después de AuthGuard, adjunta `request.profile`.
 * No captura `ProfileDeletedException`: al venir de una promesa rechazada
 * dentro de `from(...)`, el observable emite error y Nest la propaga tal
 * cual hasta GlobalExceptionFilter, sin que este interceptor la toque.
 */
@Injectable()
export class ProfileInterceptor implements NestInterceptor {
  constructor(private readonly ensureProfileExists: EnsureProfileExistsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<RequestWithUser>();

    if (!request.user) {
      return next.handle();
    }

    return from(this.ensureProfileExists.ensure(request.user.userId)).pipe(
      switchMap((profile) => {
        request.profile = profile;
        return next.handle();
      }),
    );
  }
}
