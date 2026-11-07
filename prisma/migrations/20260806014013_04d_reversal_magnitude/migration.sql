-- U12 — R9, dos disparos (TASK-db.md §3, fila 04d; ARCHITECTURE.md §3.4).
-- Magnitud = SUM(amount_cents) FILTER (WHERE amount_cents > 0).

-- Disparo 1 — sobre entries: reusa la función diferida de 04a (R1/R2/R4),
-- agregando la validación de magnitud al final. CREATE OR REPLACE porque
-- el trigger de 04a ya apunta a esta función; no hace falta recrear el
-- trigger, solo el cuerpo.
CREATE OR REPLACE FUNCTION fn_entries_deferred_checks() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_tx_id               uuid;
  v_total                bigint;
  v_count                int;
  v_currency_count       int;
  v_reverses_id          uuid;
  v_magnitude            bigint;
  v_original_magnitude   bigint;
BEGIN
  v_tx_id := COALESCE(NEW.transaction_id, OLD.transaction_id);

  -- R2 — entries_minimum_two (antes que R1: un solo entry siempre
  -- desbalancea, y el mensaje específico de R2 debe ganarle al genérico
  -- de R1 — ver TASK-db.md §3.4, R2).
  SELECT count(*) INTO v_count FROM entries WHERE transaction_id = v_tx_id;
  IF v_count = 1 THEN
    RAISE EXCEPTION 'La transacción tiene exactamente un entry' USING ERRCODE = 'P1002';
  END IF;

  -- R1 — entries_balance_zero
  SELECT SUM(amount_cents) INTO v_total FROM entries WHERE transaction_id = v_tx_id;
  IF v_total IS NOT NULL AND v_total <> 0 THEN
    RAISE EXCEPTION 'Ledger desbalanceado: %', v_total USING ERRCODE = 'P1001';
  END IF;

  -- R4 — entries_single_currency
  SELECT count(DISTINCT a.currency) INTO v_currency_count
  FROM entries e
  JOIN accounts a ON a.id = e.account_id
  WHERE e.transaction_id = v_tx_id;
  IF v_currency_count > 1 THEN
    RAISE EXCEPTION 'La transacción mezcla cuentas de distinta moneda' USING ERRCODE = 'P1004';
  END IF;

  -- R9 (lado entries) — si esta transacción es una reversa, su magnitud
  -- debe coincidir con la del original. No valida equivalencia cuenta
  -- por cuenta a propósito (§3.4).
  SELECT reverses_transaction_id INTO v_reverses_id FROM transactions WHERE id = v_tx_id;
  IF v_reverses_id IS NOT NULL THEN
    SELECT COALESCE(SUM(amount_cents) FILTER (WHERE amount_cents > 0), 0) INTO v_magnitude
      FROM entries WHERE transaction_id = v_tx_id;
    SELECT COALESCE(SUM(amount_cents) FILTER (WHERE amount_cents > 0), 0) INTO v_original_magnitude
      FROM entries WHERE transaction_id = v_reverses_id;
    IF v_magnitude <> v_original_magnitude THEN
      RAISE EXCEPTION 'La magnitud de la reversa (%) no coincide con la del original (%)', v_magnitude, v_original_magnitude
        USING ERRCODE = 'P1009';
    END IF;
  END IF;

  RETURN NULL;
END;
$$;

-- Disparo 2 — sobre transactions: cubre el hueco de una reversa con CERO
-- entries, que nunca dispararía el trigger de arriba (vive sobre
-- entries). Sin esto, esa reversa vacía consumiría
-- transactions_reverses_uniq e impediría la reversa real (§3.4).
CREATE FUNCTION fn_reversal_has_entries() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_count int;
BEGIN
  IF NEW.reverses_transaction_id IS NOT NULL THEN
    SELECT count(*) INTO v_count FROM entries WHERE transaction_id = NEW.id;
    IF v_count = 0 THEN
      RAISE EXCEPTION 'La reversa no tiene ningún entry' USING ERRCODE = 'P1009';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_reversal_has_entries
  AFTER INSERT ON transactions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION fn_reversal_has_entries();
