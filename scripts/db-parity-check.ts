import { Client } from 'pg';

/**
 * T-L04 — script de paridad (RD1, TASK-db.md §9 y §10 paso 18). Corre
 * también contra Supabase, no solo contra el contenedor de tests:
 *
 *   DATABASE_URL="<supabase>" npm run db:parity
 *
 * Mismo criterio de verificación que test/integration/l-structure.spec.ts
 * (confirmado con Luis): por CONTEO en los objetos sin nombre documentado
 * (triggers), por NOMBRE en los que sí lo tienen (funciones, el EXCLUDE,
 * enums, extensiones, policies por el patrón `<tabla>_<op>_own`).
 */

const TABLES = ['accounts', 'transactions', 'entries', 'budget_periods', 'budget_entries', 'recurring_templates'];
const QUERY_FUNCTIONS = [
  'fn_account_balances',
  'fn_category_balances',
  'fn_unassigned_funds',
  'fn_transactions_without_period',
  'fn_seed_new_user',
];

interface Check {
  name: string;
  expected: number;
  actual: number;
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL;
  if (!connectionString) {
    console.error('Falta DATABASE_URL (o TEST_DATABASE_URL) en el entorno.');
    process.exit(1);
  }

  const client = new Client({ connectionString });
  await client.connect();

  const checks: Check[] = [];
  const tableList = TABLES.map((t) => `'${t}'`).join(', ');

  const extensions = await client.query(
    `SELECT count(*)::int AS n FROM pg_extension WHERE extname IN ('pgcrypto', 'btree_gist')`,
  );
  checks.push({ name: 'extensiones (pgcrypto, btree_gist)', expected: 2, actual: extensions.rows[0].n });

  const enums = await client.query(
    `SELECT count(*)::int AS n FROM pg_type
     WHERE typname IN ('account_type', 'rollover_type', 'budget_entry_source') AND typtype = 'e'`,
  );
  checks.push({ name: 'enums (account_type, rollover_type, budget_entry_source)', expected: 3, actual: enums.rows[0].n });

  const triggers = await client.query(
    `SELECT count(*)::int AS n FROM pg_trigger t
     JOIN pg_class c ON t.tgrelid = c.oid
     WHERE c.relname IN (${tableList}) AND NOT t.tgisinternal`,
  );
  checks.push({ name: 'triggers sobre las 6 tablas de esta capa', expected: 12, actual: triggers.rows[0].n });

  const functions = await client.query(`SELECT count(*)::int AS n FROM pg_proc WHERE proname = ANY($1::text[])`, [
    QUERY_FUNCTIONS,
  ]);
  checks.push({ name: 'funciones de consulta (F1-F4) + fn_seed_new_user', expected: 5, actual: functions.rows[0].n });

  const policies = await client.query(
    `SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = 'public' AND tablename IN (${tableList})`,
  );
  checks.push({ name: 'policies RLS (4 por tabla × 6 tablas)', expected: 24, actual: policies.rows[0].n });

  const exclude = await client.query(
    `SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'budget_periods_no_overlap' AND contype = 'x'`,
  );
  checks.push({ name: 'EXCLUDE budget_periods_no_overlap', expected: 1, actual: exclude.rows[0].n });

  const views = await client.query(
    `SELECT count(*)::int AS n FROM pg_views WHERE schemaname = 'public' AND viewname = ANY($1::text[])`,
    [QUERY_FUNCTIONS],
  );
  checks.push({ name: 'F1-F4 NO son vistas', expected: 0, actual: views.rows[0].n });

  const restrictFks = await client.query(
    `SELECT count(*)::int AS n FROM pg_constraint c
     WHERE c.contype = 'f' AND c.confrelid = 'profiles'::regclass AND c.confdeltype = 'r'`,
  );
  checks.push({ name: 'FKs a profiles con ON DELETE RESTRICT', expected: 6, actual: restrictFks.rows[0].n });

  await client.end();

  const failures = checks.filter((c) => c.actual !== c.expected);

  for (const check of checks) {
    const status = check.actual === check.expected ? 'OK  ' : 'FAIL';
    console.log(`[${status}] ${check.name}: esperado=${check.expected} actual=${check.actual}`);
  }

  if (failures.length > 0) {
    console.error(`\nParidad ROJA: ${failures.length} de ${checks.length} verificaciones no coinciden.`);
    process.exit(1);
  }

  console.log(`\nParidad VERDE: ${checks.length} verificaciones coinciden.`);
}

main().catch((err) => {
  console.error('Error corriendo db-parity-check:', err);
  process.exit(1);
});
