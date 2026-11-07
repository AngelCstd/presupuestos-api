-- U10 — R3 (TASK-db.md §3, fila 04b; ARCHITECTURE.md §3.4).
-- BEFORE INSERT OR UPDATE, inmediato — entries.user_id desnormalizado
-- debe coincidir con transactions.user_id Y accounts.user_id.
CREATE FUNCTION fn_entries_owner_consistency() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_tx_user_id      uuid;
  v_account_user_id uuid;
BEGIN
  SELECT user_id INTO v_tx_user_id FROM transactions WHERE id = NEW.transaction_id;
  SELECT user_id INTO v_account_user_id FROM accounts WHERE id = NEW.account_id;

  IF NEW.user_id <> v_tx_user_id OR NEW.user_id <> v_account_user_id THEN
    RAISE EXCEPTION 'entries.user_id no coincide con transactions.user_id ni accounts.user_id'
      USING ERRCODE = 'P1003';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_entries_owner_consistency
  BEFORE INSERT OR UPDATE ON entries
  FOR EACH ROW EXECUTE FUNCTION fn_entries_owner_consistency();
