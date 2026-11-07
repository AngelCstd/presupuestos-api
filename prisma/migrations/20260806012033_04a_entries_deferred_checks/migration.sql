-- U09 — R1 + R2 + R4 (TASK-db.md §3, fila 04a; ARCHITECTURE.md §3.4).
-- Un solo CONSTRAINT TRIGGER diferido con las tres validaciones.
--
-- ⚠️ DEFERRABLE INITIALLY DEFERRED: el error aparece en el COMMIT, no en
-- el INSERT (TASK-db.md §5.1). R1 trata SUM(...) IS NULL como aprobado
-- (transacción sin entries — la cubre R2, no R1).
CREATE FUNCTION fn_entries_deferred_checks() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_tx_id uuid;
  v_total bigint;
  v_count int;
  v_currency_count int;
BEGIN
  v_tx_id := COALESCE(NEW.transaction_id, OLD.transaction_id);

  -- R2 primero — entries_minimum_two (0 entries o 2+, nunca exactamente
  -- 1). Va antes que R1 a propósito: un solo entry SIEMPRE desbalancea
  -- (entries_amount_nonzero ya prohíbe el monto 0), así que sin este
  -- orden R1 se dispara primero y esconde el mensaje específico de R2
  -- detrás de uno genérico de desbalance (TASK-db.md §3.4, R2).
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

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_entries_deferred_checks
  AFTER INSERT OR UPDATE OR DELETE ON entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION fn_entries_deferred_checks();
