-- U04 — tabla budget_periods, sin el EXCLUDE (TASK-db.md §3, fila 02b;
-- va en 03_period_exclusion, migración separada a propósito).
CREATE TABLE budget_periods (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  starts_on  date NOT NULL,
  ends_on    date NOT NULL,
  closed_at  timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT budget_periods_valid_range CHECK (ends_on >= starts_on)
);

CREATE INDEX budget_periods_user_range_idx ON budget_periods (user_id, starts_on DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX budget_periods_user_open_idx ON budget_periods (user_id)
  WHERE closed_at IS NULL AND deleted_at IS NULL;
