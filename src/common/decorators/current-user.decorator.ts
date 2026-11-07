import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/** TASK-api.md §5.7 — { userId, email }, adjuntado por AuthGuard. */
export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  const request = ctx.switchToHttp().getRequest<{ user?: { userId: string; email: string } }>();
  return request.user;
});
