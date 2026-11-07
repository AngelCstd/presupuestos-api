-- U13 — R7 (TASK-db.md §3, fila 04e; ARCHITECTURE.md §3.4).
-- Inmediato. category_id debe apuntar a una cuenta type='expense' del
-- mismo usuario.
CREATE FUNCTION fn_budget_entry_category_is_expense() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_category_type    account_type;
  v_category_user_id uuid;
BEGIN
  SELECT type, user_id INTO v_category_type, v_category_user_id
  FROM accounts WHERE id = NEW.category_id;

  IF v_category_type IS DISTINCT FROM 'expense' OR v_category_user_id IS DISTINCT FROM NEW.user_id THEN
    RAISE EXCEPTION 'category_id debe apuntar a una cuenta expense del mismo usuario'
      USING ERRCODE = 'P1007';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_budget_entry_category_is_expense
  BEFORE INSERT OR UPDATE ON budget_entries
  FOR EACH ROW EXECUTE FUNCTION fn_budget_entry_category_is_expense();
