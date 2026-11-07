-- U08a — tabla recurring_templates (TASK-db.md §3, fila 02f; ARCHITECTURE.md §3.3).
-- Hoja del grafo: ninguna otra migración depende de ella.
CREATE TABLE recurring_templates (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  name               text NOT NULL,
  account_id         uuid REFERENCES accounts(id),
  category_id        uuid NOT NULL REFERENCES accounts(id),
  amount_cents       bigint NOT NULL,
  day_of_month       smallint NOT NULL,
  next_due_on        date NOT NULL,
  last_confirmed_on  date,
  is_active          boolean NOT NULL DEFAULT true,
  deleted_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT recurring_day_range CHECK (day_of_month BETWEEN 1 AND 31),
  CONSTRAINT recurring_amount_positive CHECK (amount_cents > 0)
);

CREATE INDEX recurring_user_due_idx ON recurring_templates (user_id, next_due_on)
  WHERE is_active = true AND deleted_at IS NULL;
