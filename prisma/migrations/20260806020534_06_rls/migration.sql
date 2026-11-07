-- U20 — RLS (TASK-db.md §3, fila 06; ARCHITECTURE.md §3.8).
-- Mismo patrón en las 6 tablas: 4 policies (SELECT/INSERT/UPDATE/DELETE),
-- todas "propiedad de fila" vía user_id = auth.uid(). UPDATE lleva
-- USING y WITH CHECK. Se despliega pero no se testea semánticamente
-- (§3.8, C1 resuelto) — el rol `authenticated` lo provisiona Supabase en
-- producción; en local lo crea el stub de TASK-auth.

ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY accounts_select_own ON accounts
  FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY accounts_insert_own ON accounts
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY accounts_update_own ON accounts
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY accounts_delete_own ON accounts
  FOR DELETE TO authenticated USING (user_id = auth.uid());

ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY transactions_select_own ON transactions
  FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY transactions_insert_own ON transactions
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY transactions_update_own ON transactions
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY transactions_delete_own ON transactions
  FOR DELETE TO authenticated USING (user_id = auth.uid());

-- entries: user_id desnormalizado a propósito (§3.8) para no necesitar
-- JOIN a transactions en la policy — su consistencia la garantiza R3.
ALTER TABLE entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY entries_select_own ON entries
  FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY entries_insert_own ON entries
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY entries_update_own ON entries
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY entries_delete_own ON entries
  FOR DELETE TO authenticated USING (user_id = auth.uid());

ALTER TABLE budget_periods ENABLE ROW LEVEL SECURITY;
CREATE POLICY budget_periods_select_own ON budget_periods
  FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY budget_periods_insert_own ON budget_periods
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY budget_periods_update_own ON budget_periods
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY budget_periods_delete_own ON budget_periods
  FOR DELETE TO authenticated USING (user_id = auth.uid());

ALTER TABLE budget_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY budget_entries_select_own ON budget_entries
  FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY budget_entries_insert_own ON budget_entries
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY budget_entries_update_own ON budget_entries
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY budget_entries_delete_own ON budget_entries
  FOR DELETE TO authenticated USING (user_id = auth.uid());

ALTER TABLE recurring_templates ENABLE ROW LEVEL SECURITY;
CREATE POLICY recurring_templates_select_own ON recurring_templates
  FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY recurring_templates_insert_own ON recurring_templates
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY recurring_templates_update_own ON recurring_templates
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY recurring_templates_delete_own ON recurring_templates
  FOR DELETE TO authenticated USING (user_id = auth.uid());
