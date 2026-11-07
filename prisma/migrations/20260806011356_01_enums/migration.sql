-- U02 — enums (TASK-db.md §3, fila 01; ARCHITECTURE.md §3.3).
CREATE TYPE account_type AS ENUM (
  'asset', 'receivable', 'liability', 'income', 'expense', 'equity'
);
CREATE TYPE rollover_type AS ENUM ('accumulate', 'reset');
CREATE TYPE budget_entry_source AS ENUM ('manual', 'rollover');
