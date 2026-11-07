-- U11 — R5 + R6 (TASK-db.md §3, fila 04c; ARCHITECTURE.md §3.4).
-- Ambos inmediatos, cada uno en su tabla.

-- R5 — entries_immutable: bloquea UPDATE y DELETE, sin excepciones.
CREATE FUNCTION fn_entries_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'entries es inmutable — la corrección es una transacción de reversa'
    USING ERRCODE = 'P1005';
END;
$$;

CREATE TRIGGER trg_entries_immutable
  BEFORE UPDATE OR DELETE ON entries
  FOR EACH ROW EXECUTE FUNCTION fn_entries_immutable();

-- R6 — transactions_immutable: bloquea DELETE siempre; en UPDATE, solo
-- permite cambiar `description`.
CREATE FUNCTION fn_transactions_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'transactions es inmutable — no se puede borrar' USING ERRCODE = 'P1006';
  END IF;

  IF NEW.booked_at IS DISTINCT FROM OLD.booked_at
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.reverses_transaction_id IS DISTINCT FROM OLD.reverses_transaction_id
  THEN
    RAISE EXCEPTION 'transactions es inmutable salvo description' USING ERRCODE = 'P1006';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_transactions_immutable
  BEFORE UPDATE OR DELETE ON transactions
  FOR EACH ROW EXECUTE FUNCTION fn_transactions_immutable();
