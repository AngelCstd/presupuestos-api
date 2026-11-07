-- U19 — F4 (TASK-db.md §3, fila 05d; ARCHITECTURE.md §3.9, firma exacta).
CREATE FUNCTION fn_transactions_without_period(p_user_id uuid)
RETURNS TABLE (
  transaction_id uuid,
  booked_at      date,
  description    text
)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT t.id, t.booked_at, t.description
  FROM transactions t
  WHERE t.user_id = p_user_id
    AND NOT EXISTS (
      SELECT 1
      FROM budget_periods bp
      WHERE bp.user_id = p_user_id
        AND bp.deleted_at IS NULL
        AND t.booked_at BETWEEN bp.starts_on AND bp.ends_on
    )
  ORDER BY t.booked_at DESC;
$$;
