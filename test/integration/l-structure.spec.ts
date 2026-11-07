import { pool, closePool } from '../setup/db';

const TABLES = ['accounts', 'transactions', 'entries', 'budget_periods', 'budget_entries', 'recurring_templates'];
const F1_TO_F4 = [
  'fn_account_balances',
  'fn_category_balances',
  'fn_unassigned_funds',
  'fn_transactions_without_period',
];
const QUERY_FUNCTIONS = [...F1_TO_F4, 'fn_seed_new_user'];

/**
 * Lista nominal de los 9 triggers de esta capa — reemplaza el conteo
 * suelto de "12" que traía T-L03. Ese número nunca vino con desglose
 * (confirmado con Luis: "un conteo agregado sin desglose no es una
 * especificación"); esta lista SÍ lo es — nombre, tabla, timing, eventos
 * y qué regla implementa cada uno — y es lo que T-L03/T-L08 verifican
 * ahora, no un total mágico. Las 11 reglas (R1-R11) están todas
 * cubiertas, repartidas en estos 9 objetos físicos.
 */
const EXPECTED_TRIGGERS: Array<{
  name: string;
  table: string;
  timing: 'BEFORE' | 'AFTER';
  events: string[];
  rule: string;
}> = [
  { name: 'trg_entries_deferred_checks', table: 'entries', timing: 'AFTER', events: ['INSERT', 'UPDATE', 'DELETE'], rule: 'R1, R2, R4, R9 (lado entries)' },
  { name: 'trg_entries_owner_consistency', table: 'entries', timing: 'BEFORE', events: ['INSERT', 'UPDATE'], rule: 'R3' },
  { name: 'trg_entries_immutable', table: 'entries', timing: 'BEFORE', events: ['UPDATE', 'DELETE'], rule: 'R5' },
  { name: 'trg_transactions_immutable', table: 'transactions', timing: 'BEFORE', events: ['UPDATE', 'DELETE'], rule: 'R6' },
  { name: 'trg_reversal_has_entries', table: 'transactions', timing: 'AFTER', events: ['INSERT'], rule: 'R9 (lado transactions)' },
  { name: 'trg_budget_entry_category_is_expense', table: 'budget_entries', timing: 'BEFORE', events: ['INSERT', 'UPDATE'], rule: 'R7' },
  { name: 'trg_accounts_archive_requires_zero_balance', table: 'accounts', timing: 'BEFORE', events: ['UPDATE'], rule: 'R8' },
  { name: 'trg_budget_period_dates_locked_when_closed', table: 'budget_periods', timing: 'BEFORE', events: ['UPDATE'], rule: 'R10' },
  { name: 'trg_budget_entries_locked_when_period_closed', table: 'budget_entries', timing: 'BEFORE', events: ['INSERT', 'UPDATE', 'DELETE'], rule: 'R11' },
];

async function actualTriggerEvents(name: string, table: string): Promise<{ timing: string; events: string[] } | null> {
  const { rows } = await pool.query(
    `SELECT DISTINCT action_timing, event_manipulation
     FROM information_schema.triggers
     WHERE trigger_name = $1 AND event_object_table = $2 AND event_object_schema = 'public'`,
    [name, table],
  );
  if (rows.length === 0) return null;
  return {
    timing: rows[0].action_timing,
    events: rows.map((r: { event_manipulation: string }) => r.event_manipulation).sort(),
  };
}
describe('Grupo L — estructura y reproducibilidad (catálogos de Postgres)', () => {
  afterAll(async () => {
    await closePool();
  });

  it('T-L01: pg_extension trae pgcrypto y btree_gist', async () => {
    const { rows } = await pool.query(
      `SELECT extname FROM pg_extension WHERE extname IN ('pgcrypto', 'btree_gist')`,
    );
    expect(rows).toHaveLength(2);
  });

  it('T-L02: pg_enum de account_type trae los seis valores, incluido receivable', async () => {
    const { rows } = await pool.query(
      `SELECT e.enumlabel FROM pg_enum e
       JOIN pg_type t ON e.enumtypid = t.oid
       WHERE t.typname = 'account_type'
       ORDER BY e.enumsortorder`,
    );
    const labels = rows.map((r: { enumlabel: string }) => r.enumlabel);
    expect(labels).toEqual(['asset', 'receivable', 'liability', 'income', 'expense', 'equity']);
  });

  it('T-L03: reset+deploy sobre contenedor limpio da los 9 triggers esperados (nominal, por nombre/tabla/eventos), 5 funciones, 24 policies, el EXCLUDE, 3 enums, 2 extensiones', async () => {
    const tableList = TABLES.map((t) => `'${t}'`).join(', ');

    // Verificación nominal: cada trigger esperado existe con el timing y
    // los eventos exactos que implementan su regla — no un conteo suelto.
    for (const expected of EXPECTED_TRIGGERS) {
      const actual = await actualTriggerEvents(expected.name, expected.table);
      expect(actual).not.toBeNull();
      expect(actual?.timing).toBe(expected.timing);
      expect(actual?.events).toEqual([...expected.events].sort());
    }

    // Y que no haya triggers de más (drift: alguien agregó uno que esta
    // lista no conoce).
    const triggers = await pool.query(
      `SELECT count(*)::int AS n FROM pg_trigger t
       JOIN pg_class c ON t.tgrelid = c.oid
       WHERE c.relname IN (${tableList}) AND NOT t.tgisinternal`,
    );
    expect(triggers.rows[0].n).toBe(EXPECTED_TRIGGERS.length);

    const functions = await pool.query(
      `SELECT count(*)::int AS n FROM pg_proc WHERE proname = ANY($1::text[])`,
      [QUERY_FUNCTIONS],
    );
    expect(functions.rows[0].n).toBe(5);

    const policies = await pool.query(
      `SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = 'public' AND tablename IN (${tableList})`,
    );
    expect(policies.rows[0].n).toBe(24);

    const exclude = await pool.query(
      `SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'budget_periods_no_overlap' AND contype = 'x'`,
    );
    expect(exclude.rows[0].n).toBe(1);

    const enums = await pool.query(
      `SELECT count(*)::int AS n FROM pg_type
       WHERE typname IN ('account_type', 'rollover_type', 'budget_entry_source') AND typtype = 'e'`,
    );
    expect(enums.rows[0].n).toBe(3);

    const extensions = await pool.query(
      `SELECT count(*)::int AS n FROM pg_extension WHERE extname IN ('pgcrypto', 'btree_gist')`,
    );
    expect(extensions.rows[0].n).toBe(2);
  });

  it('T-L05: rowsecurity=true en las seis tablas; 24 policies', async () => {
    const tableList = TABLES.map((t) => `'${t}'`).join(', ');

    const rls = await pool.query(
      `SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename IN (${tableList})`,
    );
    expect(rls.rows).toHaveLength(6);
    expect(rls.rows.every((r: { rowsecurity: boolean }) => r.rowsecurity === true)).toBe(true);

    const policies = await pool.query(
      `SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = 'public' AND tablename IN (${tableList})`,
    );
    expect(policies.rows[0].n).toBe(24);
  });

  it('T-L06: pg_views no incluye ninguna de las funciones de consulta — son funciones, no vistas', async () => {
    // "0 vistas" es vacuamente cierto sobre una base vacía. Se exige
    // también que las 4 SÍ existan como funciones (pg_proc), para que
    // este test no pueda pasar antes de que F1-F4 estén implementadas.
    const functions = await pool.query(
      `SELECT count(*)::int AS n FROM pg_proc WHERE proname = ANY($1::text[])`,
      [F1_TO_F4],
    );
    expect(functions.rows[0].n).toBe(4);

    const { rows } = await pool.query(
      `SELECT viewname FROM pg_views WHERE schemaname = 'public' AND viewname = ANY($1::text[])`,
      [F1_TO_F4],
    );
    expect(rows).toHaveLength(0);
  });

  it('T-L07: las seis FKs a profiles tienen confdeltype = r (RESTRICT)', async () => {
    const { rows } = await pool.query(
      `SELECT conname, confdeltype FROM pg_constraint c
       JOIN pg_class rel ON c.conrelid = rel.oid
       WHERE c.contype = 'f' AND c.confrelid = 'profiles'::regclass`,
    );
    expect(rows).toHaveLength(6);
    expect(rows.every((r: { confdeltype: string }) => r.confdeltype === 'r')).toBe(true);
  });

  it('T-L08: R9 dispara en dos puntos — trg_reversal_has_entries (AFTER INSERT, transactions) y trg_entries_deferred_checks (lado entries)', async () => {
    // Antes usaba un bitmask de pg_trigger.tgtype para detectar "AFTER" y
    // comparaba el bit equivocado (16 = UPDATE, no AFTER) — por eso nunca
    // encontraba trg_reversal_has_entries, que es AFTER INSERT. Se
    // reemplaza por information_schema.triggers.action_timing, que no
    // requiere interpretar bits a mano, y se verifica por nombre — los
    // mismos dos triggers que ya lista EXPECTED_TRIGGERS para R9.
    const onTransactions = await actualTriggerEvents('trg_reversal_has_entries', 'transactions');
    expect(onTransactions).not.toBeNull();
    expect(onTransactions?.timing).toBe('AFTER');
    expect(onTransactions?.events).toEqual(['INSERT']);

    const onEntries = await actualTriggerEvents('trg_entries_deferred_checks', 'entries');
    expect(onEntries).not.toBeNull();
    expect(onEntries?.timing).toBe('AFTER');
  });
});
