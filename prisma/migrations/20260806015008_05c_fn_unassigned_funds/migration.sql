-- U18 — F3 ⚠️ la unidad más delicada (TASK-db.md §3, fila 05c;
-- ARCHITECTURE.md §3.9, firma exacta). Firma de un solo parámetro,
-- agregación por par (categoría, periodo abierto), excluye periodos
-- cerrados. NO simplificar a SUM(asignado) - SUM(gastado): reintroduce
-- el Fallo B (T-G14/T-G15/T-G16/T-G17 lo detectan).
CREATE FUNCTION fn_unassigned_funds(p_user_id uuid)
RETURNS TABLE (
  unassigned_cents bigint
)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  WITH cash AS (
    SELECT COALESCE(SUM(e.amount_cents), 0)::bigint AS cents
    FROM entries e
    JOIN accounts a ON a.id = e.account_id
    WHERE e.user_id = p_user_id
      AND a.type IN ('asset', 'liability')
  ),
  open_periods AS (
    SELECT bp.id, bp.starts_on, bp.ends_on
    FROM budget_periods bp
    WHERE bp.user_id = p_user_id
      AND bp.closed_at  IS NULL
      AND bp.deleted_at IS NULL
  ),
  pair AS (
    SELECT
      COALESCE((
        SELECT SUM(be.amount_cents)
        FROM budget_entries be
        WHERE be.period_id   = op.id
          AND be.category_id = c.id
          AND be.deleted_at IS NULL
      ), 0)
      -
      COALESCE((
        SELECT SUM(e.amount_cents)
        FROM entries e
        JOIN transactions t ON t.id = e.transaction_id
        WHERE e.account_id = c.id
          AND t.booked_at BETWEEN op.starts_on AND op.ends_on
      ), 0) AS available
    FROM accounts c
    CROSS JOIN open_periods op
    WHERE c.user_id = p_user_id
      AND c.type = 'expense'
  )
  SELECT (
    cash.cents
    - COALESCE((
        SELECT SUM( GREATEST(p.available, 0) + ABS(LEAST(p.available, 0)) )
        FROM pair p
      ), 0)
  )::bigint
  FROM cash;
$$;
