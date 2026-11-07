-- U04 (cont.) — EXCLUDE de no-traslape, separada de 02b a propósito
-- (TASK-db.md §3, fila 03): si se mete dentro de 02b y btree_gist no
-- está, falla toda la creación de la tabla en vez de solo el constraint.
-- El predicado WHERE (deleted_at IS NULL) no es opcional (§3.3).
ALTER TABLE budget_periods ADD CONSTRAINT budget_periods_no_overlap
  EXCLUDE USING gist (
    user_id WITH =,
    daterange(starts_on, ends_on, '[]') WITH &&
  ) WHERE (deleted_at IS NULL);
