-- U17 — F2 (TASK-db.md §3, fila 05b; ARCHITECTURE.md §3.9, firma exacta).
CREATE FUNCTION fn_category_balances(p_user_id uuid, p_period_id uuid)
RETURNS TABLE (
  category_id      uuid,
  name             text,
  assigned_cents   bigint,
  spent_cents      bigint,
  available_cents  bigint,
  has_budget       boolean
)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  WITH period AS (
    SELECT bp.starts_on, bp.ends_on
    FROM budget_periods bp
    WHERE bp.id = p_period_id
      AND bp.user_id = p_user_id
      AND bp.deleted_at IS NULL
  ),
  assigned AS (
    SELECT be.category_id,
           SUM(be.amount_cents)::bigint AS cents,
           count(*)                     AS n
    FROM budget_entries be
    WHERE be.user_id = p_user_id
      AND be.period_id = p_period_id
      AND be.deleted_at IS NULL
    GROUP BY be.category_id
  ),
  spent AS (
    SELECT e.account_id AS category_id,
           SUM(e.amount_cents)::bigint AS cents
    FROM entries e
    JOIN transactions t ON t.id = e.transaction_id
    CROSS JOIN period p
    WHERE e.user_id = p_user_id
      AND t.booked_at BETWEEN p.starts_on AND p.ends_on
    GROUP BY e.account_id
  )
  SELECT a.id,
         a.name,
         COALESCE(asg.cents, 0)::bigint,
         COALESCE(sp.cents, 0)::bigint,
         (COALESCE(asg.cents, 0) - COALESCE(sp.cents, 0))::bigint,
         COALESCE(asg.n, 0) > 0
  FROM accounts a
  LEFT JOIN assigned asg ON asg.category_id = a.id
  LEFT JOIN spent    sp  ON sp.category_id  = a.id
  WHERE a.user_id = p_user_id
    AND a.type = 'expense';
$$;
