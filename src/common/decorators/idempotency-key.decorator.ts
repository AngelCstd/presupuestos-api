import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { MissingIdempotencyKeyException } from '../errors/missing-idempotency-key.exception';
import { InvalidIdempotencyKeyException } from '../errors/invalid-idempotency-key.exception';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface RequestWithHeaders {
  headers: Record<string, string | string[] | undefined>;
}

/**
 * TASK-api.md §5.1 — un solo lugar para las nueve rutas que exigen el
 * header (los siete de `/transactions/*`, la reversa y
 * `/recurring-templates/{id}/confirm`), compartido vía `common/` (D4).
 */
export const IdempotencyKey = createParamDecorator((_: unknown, ctx: ExecutionContext): string => {
  const request = ctx.switchToHttp().getRequest<RequestWithHeaders>();
  const raw = request.headers['idempotency-key'];
  const value = Array.isArray(raw) ? raw[0] : raw;

  if (!value) {
    throw new MissingIdempotencyKeyException();
  }
  if (!UUID_RE.test(value)) {
    throw new InvalidIdempotencyKeyException();
  }
  return value;
});
