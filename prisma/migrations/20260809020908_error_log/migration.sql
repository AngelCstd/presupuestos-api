-- TASK-auth.md, Entregables: "Modelo Prisma ErrorLog: message, stack,
-- context, userId (nullable), metadata (Json, nullable), createdAt."
-- Sin FK hacia profiles: el registro de errores debe ser best-effort
-- (TASK-auth.md, GlobalExceptionFilter) — una FK que pudiera violarse
-- volvería la escritura del log tan frágil como el error que intenta
-- registrar. `stack`/`context` nullables: no todo error tiene un stack
-- construido a propósito (ver error-log-serializer.integration.spec.ts,
-- T-11).
CREATE TABLE error_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message     text NOT NULL,
  stack       text,
  context     text,
  user_id     uuid,
  metadata    jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
