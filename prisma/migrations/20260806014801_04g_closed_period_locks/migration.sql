-- U15 — R10 + R11 (TASK-db.md §3, fila 04g; ARCHITECTURE.md §3.4).
-- Ambos inmediatos.

-- R10 — budget_period_dates_locked_when_closed: bloquea cambiar
-- starts_on/ends_on si el periodo está cerrado. closed_at y deleted_at
-- SÍ se pueden seguir cambiando (reapertura, soft delete).
CREATE FUNCTION fn_budget_period_dates_locked_when_closed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.closed_at IS NOT NULL
     AND (NEW.starts_on IS DISTINCT FROM OLD.starts_on OR NEW.ends_on IS DISTINCT FROM OLD.ends_on)
  THEN
    RAISE EXCEPTION 'No se pueden editar las fechas de un periodo cerrado' USING ERRCODE = 'P1010';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_budget_period_dates_locked_when_closed
  BEFORE UPDATE ON budget_periods
  FOR EACH ROW EXECUTE FUNCTION fn_budget_period_dates_locked_when_closed();

-- R11 — budget_entries_locked_when_period_closed: bloquea UPDATE y
-- DELETE (incluido el soft delete, que es un UPDATE de deleted_at) sobre
-- un budget_entry cuyo periodo esté cerrado. Sin excepciones, aplica
-- igual a source='manual' y 'rollover'.
CREATE FUNCTION fn_budget_entries_locked_when_period_closed() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_period_id uuid;
  v_closed_at timestamptz;
BEGIN
  v_period_id := COALESCE(NEW.period_id, OLD.period_id);
  SELECT closed_at INTO v_closed_at FROM budget_periods WHERE id = v_period_id;

  IF v_closed_at IS NOT NULL THEN
    RAISE EXCEPTION 'No se puede editar ni borrar un budget_entry de un periodo cerrado'
      USING ERRCODE = 'P1011';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER trg_budget_entries_locked_when_period_closed
  BEFORE UPDATE OR DELETE ON budget_entries
  FOR EACH ROW EXECUTE FUNCTION fn_budget_entries_locked_when_period_closed();
