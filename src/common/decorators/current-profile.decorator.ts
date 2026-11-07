import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/** TASK-api.md §5.7 — ProfileRow, adjuntado por ProfileInterceptor. */
export const CurrentProfile = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  const request = ctx.switchToHttp().getRequest<{ profile?: unknown }>();
  return request.profile;
});
