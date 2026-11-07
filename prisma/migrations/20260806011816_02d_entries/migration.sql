-- U06 — tabla entries (TASK-db.md §3, fila 02d; ARCHITECTURE.md §3.3).
-- bigint + CHECK de monto no-cero. Las tres FKs ON DELETE RESTRICT. Sin
-- deleted_at (rompería la validación de suma-cero, §3.3).
CREATE TABLE entries (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id uuid NOT NULL REFERENCES transactions(id) ON DELETE RESTRICT,
  user_id        uuid NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  account_id     uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  amount_cents   bigint NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT entries_amount_nonzero CHECK (amount_cents <> 0)
);

CREATE INDEX entries_transaction_idx  ON entries (transaction_id);
CREATE INDEX entries_account_idx      ON entries (account_id);
CREATE INDEX entries_user_account_idx ON entries (user_id, account_id);
