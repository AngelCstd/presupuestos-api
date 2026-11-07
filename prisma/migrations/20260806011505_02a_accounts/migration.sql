-- U03 — tabla accounts (TASK-db.md §3, fila 02a; ARCHITECTURE.md §3.3).
CREATE TABLE accounts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  name           text NOT NULL,
  type           account_type NOT NULL,
  currency       char(3) NOT NULL DEFAULT 'MXN',
  rollover_type  rollover_type,
  is_system      boolean NOT NULL DEFAULT false,
  archived_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT accounts_rollover_consistency CHECK (
    (type = 'expense' AND rollover_type IS NOT NULL)
    OR (type <> 'expense' AND rollover_type IS NULL)
  ),
  CONSTRAINT accounts_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT accounts_system_is_equity CHECK (is_system = false OR type = 'equity')
);

CREATE UNIQUE INDEX accounts_user_name_active_uniq
  ON accounts (user_id, lower(name))
  WHERE archived_at IS NULL;

CREATE INDEX accounts_user_idx ON accounts (user_id);
CREATE INDEX accounts_user_type_idx ON accounts (user_id, type) WHERE archived_at IS NULL;
