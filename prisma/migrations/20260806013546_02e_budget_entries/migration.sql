-- U07 — tabla budget_entries (TASK-db.md §3, fila 02e; ARCHITECTURE.md §3.3).
CREATE TABLE budget_entries (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  period_id    uuid NOT NULL REFERENCES budget_periods(id) ON DELETE RESTRICT,
  category_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  amount_cents bigint NOT NULL,
  source       budget_entry_source NOT NULL DEFAULT 'manual',
  note         text,
  deleted_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT budget_entries_amount_nonzero CHECK (amount_cents <> 0)
);

-- Máximo un entry de rollover vigente por (periodo, categoría).
CREATE UNIQUE INDEX budget_entries_rollover_uniq
  ON budget_entries (period_id, category_id)
  WHERE source = 'rollover' AND deleted_at IS NULL;

CREATE INDEX budget_entries_period_idx ON budget_entries (period_id)
  WHERE deleted_at IS NULL;
CREATE INDEX budget_entries_category_idx ON budget_entries (category_id)
  WHERE deleted_at IS NULL;
CREATE INDEX budget_entries_user_period_cat_idx ON budget_entries (user_id, period_id, category_id)
  WHERE deleted_at IS NULL;
