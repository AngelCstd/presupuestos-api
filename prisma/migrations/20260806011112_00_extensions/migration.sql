-- U01 — extensiones. Sin dependencias (TASK-db.md §3, fila 00).
-- pgcrypto: gen_random_uuid(), usado como DEFAULT en todos los PK de esta capa.
-- btree_gist: requerido por el EXCLUDE de budget_periods (03_period_exclusion).
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;
