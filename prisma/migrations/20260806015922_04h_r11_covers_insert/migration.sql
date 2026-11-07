-- Corrección a R11 (04g): ARCHITECTURE.md §3.4 la redacta como "BEFORE
-- UPDATE OR DELETE", pero §3.10 describe el cierre desordenado como
-- bloqueado por R11 al INTENTAR INSERTAR el rollover en un periodo ya
-- cerrado (T-N06) — eso solo es posible si R11 también dispara en
-- INSERT. Confirmado con Luis: §3.4 quedó desactualizada, se amplía el
-- trigger existente (misma función, no hace falta tocarla — ya usa
-- COALESCE(NEW.period_id, OLD.period_id), válido también en INSERT).
DROP TRIGGER trg_budget_entries_locked_when_period_closed ON budget_entries;

CREATE TRIGGER trg_budget_entries_locked_when_period_closed
  BEFORE INSERT OR UPDATE OR DELETE ON budget_entries
  FOR EACH ROW EXECUTE FUNCTION fn_budget_entries_locked_when_period_closed();
