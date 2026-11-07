-- U05 — tabla transactions (TASK-db.md §3, fila 02c; ARCHITECTURE.md §3.3).
-- Sin updated_at (no aplica: la tabla es inmutable salvo `description`,
-- y updated_at lo gestiona Prisma solo donde existe la columna).
CREATE TABLE transactions (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  uuid NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  booked_at                date NOT NULL,
  description              text NOT NULL,
  idempotency_key          uuid,
  reverses_transaction_id  uuid REFERENCES transactions(id),
  created_at               timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT transactions_no_self_reversal CHECK (id <> reverses_transaction_id)
);

CREATE UNIQUE INDEX transactions_reverses_uniq
  ON transactions (reverses_transaction_id)
  WHERE reverses_transaction_id IS NOT NULL;

CREATE UNIQUE INDEX transactions_idempotency_uniq
  ON transactions (user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX transactions_user_booked_idx  ON transactions (user_id, booked_at DESC);
CREATE INDEX transactions_user_created_idx ON transactions (user_id, created_at DESC);
