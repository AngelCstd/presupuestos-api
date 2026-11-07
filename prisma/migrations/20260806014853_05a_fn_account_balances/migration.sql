-- U16 — F1 (TASK-db.md §3, fila 05a; ARCHITECTURE.md §3.9, firma exacta).
CREATE FUNCTION fn_account_balances(p_user_id uuid)
RETURNS TABLE (
  account_id uuid, name text, type account_type,
  currency char(3), balance_cents bigint
)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT a.id, a.name, a.type, a.currency,
         COALESCE(SUM(e.amount_cents), 0)::bigint
  FROM accounts a
  LEFT JOIN entries e ON e.account_id = a.id
  WHERE a.user_id = p_user_id
  GROUP BY a.id;
$$;
