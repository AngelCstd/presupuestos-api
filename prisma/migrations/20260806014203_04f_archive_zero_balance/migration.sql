-- U14 — R8 (TASK-db.md §3, fila 04f; ARCHITECTURE.md §3.4).
-- Solo asset/receivable/liability; expense/income/equity exentas (su
-- saldo es un acumulado histórico que nunca vuelve a cero por diseño).
CREATE FUNCTION fn_accounts_archive_requires_zero_balance() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_balance bigint;
BEGIN
  IF OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL
     AND NEW.type IN ('asset', 'receivable', 'liability')
  THEN
    SELECT COALESCE(SUM(amount_cents), 0) INTO v_balance FROM entries WHERE account_id = NEW.id;
    IF v_balance <> 0 THEN
      RAISE EXCEPTION 'No se puede archivar una cuenta con saldo distinto de cero (saldo: %)', v_balance
        USING ERRCODE = 'P1008';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_accounts_archive_requires_zero_balance
  BEFORE UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION fn_accounts_archive_requires_zero_balance();
