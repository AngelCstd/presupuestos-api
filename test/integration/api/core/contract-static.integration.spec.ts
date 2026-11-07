import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

// Grupo R-core — contrato estático y estructural (TASK-api.md §11.0):
// exactamente los 5 IDs verificables sin HTTP ni endpoints de dominio —
// T-R05, R06, R07, R08, R10. El resto de Grupo R (T-R01–04, R09, R11, R12)
// necesita la superficie completa y vive en contract-fixtures.integration.spec.ts,
// loop 2.
//
// Todas las aserciones de ausencia van precedidas de una aserción positiva
// (archivos existen, directorio no vacío) — con src/ casi vacío hoy, un
// grep sin precondición "pasaría" por no encontrar nada que revisar, no
// por cumplir la regla. Eso ya nos mordió una vez.

const REPO_ROOT = join(__dirname, '../../../..');
const SRC = join(REPO_ROOT, 'src');

const DOMAIN_MODULES = ['profile', 'accounts', 'categories', 'transactions', 'budget', 'recurring', 'insights'];
const ALLOWED_NON_DOMAIN_IMPORTS = [
  'accounts-data',
  'periods-data',
  'queries',
  'ledger',
  'auth',
  'common',
  '@nestjs',
  '@prisma',
];

// T-R06/T-R07/T-R08 escanean SOLO lo que construye A00–A06 (los 7 módulos
// de dominio + src/shared, que trae AccountsDataModule/QueriesModule/
// LedgerModule/PeriodsDataModule). Deliberadamente NO incluye src/auth/
// ni src/common/logging/: son de TASK-auth, ya cerrada, con sus propias
// reglas — EnsureProfileExistsService usa PrismaClient a propósito (así
// lo pidió esa tarea), y D1 ("un Service nunca importa PrismaClient") es
// una regla nueva de ESTA capa, no retroactiva sobre la anterior. Sin
// este acotamiento, T-R06 reporta un falso positivo real contra código
// ya aprobado.
const A00_A06_ROOTS = [...DOMAIN_MODULES.map((mod) => join(SRC, mod)), join(SRC, 'shared')];

function listFilesRecursive(dir: string, predicate: (name: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(full, predicate));
    else if (predicate(entry.name)) out.push(full);
  }
  return out;
}

describe('Grupo R-core — contract-static.integration.spec.ts (contrato estático, sin HTTP)', () => {
  it('T-R05: ningún módulo de dominio importa a otro módulo de dominio (D4)', () => {
    const moduleFiles = DOMAIN_MODULES.flatMap((mod) =>
      listFilesRecursive(join(SRC, mod), (name) => name.endsWith('.module.ts')),
    );

    // Positiva primero: si esto falla, es que los módulos de dominio
    // todavía no existen — la unidad no está lista para T-R05, no que
    // D4 se cumpla.
    expect(moduleFiles.length).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const file of moduleFiles) {
      const source = readFileSync(file, 'utf-8');
      const importMatches = [...source.matchAll(/from ['"](.+?)['"]/g)].map((m) => m[1]);
      for (const spec of importMatches) {
        if (!spec.startsWith('.')) continue; // paquetes externos, no aplica
        const otherDomain = DOMAIN_MODULES.find((mod) => spec.includes(`/${mod}/`) || spec.includes(`../../${mod}`));
        const isSelf = DOMAIN_MODULES.some((mod) => file.includes(`/${mod}/`) && spec.includes(mod));
        if (otherDomain && !isSelf && !ALLOWED_NON_DOMAIN_IMPORTS.some((allowed) => spec.includes(allowed))) {
          violations.push(`${file} importa "${spec}"`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('T-R06: PrismaClient no aparece en ningún *.service.ts ni *.controller.ts de A00–A06', () => {
    const files = A00_A06_ROOTS.flatMap((root) =>
      listFilesRecursive(root, (name) => name.endsWith('.service.ts') || name.endsWith('.controller.ts')),
    );

    expect(files.length).toBeGreaterThan(0);

    const withPrisma = files.filter((f) => /PrismaClient/.test(readFileSync(f, 'utf-8')));
    expect(withPrisma).toEqual([]);
  });

  it('T-R07: vocabulario de partida doble ausente de src/**/dto/ (excepto "credit", ver nota)', () => {
    const dtoFiles = A00_A06_ROOTS.flatMap((root) =>
      listFilesRecursive(root, (name) => name.endsWith('.dto.ts')),
    ).filter((f) => f.includes('/dto/'));

    expect(dtoFiles.length).toBeGreaterThan(0);

    // "credit" queda fuera de este grep — decisión de Luis: gana el
    // `kind` público (ya está en API-CONTRACT.md, ejemplos JSON
    // incluidos). "debit" sí es jerga contable pura, sin uso legítimo en
    // el contrato — se mantiene. Ver TASK-api.md §5.6, nota agregada al
    // resolver la contradicción.
    const forbidden = ['entries', 'debit', 'asset', 'liability', 'equity'];
    const violations: string[] = [];
    for (const file of dtoFiles) {
      const source = readFileSync(file, 'utf-8');
      for (const term of forbidden) {
        if (new RegExp(`\\b${term}\\b`, 'i').test(source)) {
          violations.push(`${file} contiene "${term}"`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('T-R08: "reopen" no aparece en ningún archivo de A00–A06 — P-02 fuera de alcance', () => {
    const budgetFiles = listFilesRecursive(join(SRC, 'budget'), () => true);
    expect(budgetFiles.length).toBeGreaterThan(0);

    const allFiles = A00_A06_ROOTS.flatMap((root) => listFilesRecursive(root, (name) => name.endsWith('.ts')));
    const withReopen = allFiles.filter((f) => /reopen/i.test(readFileSync(f, 'utf-8')));
    expect(withReopen).toEqual([]);
  });

  it('T-R10: cero migraciones nuevas fuera de las autorizadas — sustituto sin git (el repo no tiene git inicializado)', () => {
    // TASK-api.md pide `git status` de prisma/migrations/. Este repo no
    // es un repositorio git (confirmado al inicio de la sesión) — no hay
    // forma de correr ese comando. Sustituto acordado con Luis, dos
    // verificaciones independientes que detectan lo mismo (una migración
    // nueva) sin depender de control de versiones:
    //   1. El conteo de carpetas en prisma/migrations/ coincide con el
    //      número fijado aquí.
    //   2. `prisma migrate status` confirma que no hay drift ni
    //      migraciones pendientes de aplicar.
    // Nació como guardrail de "no crear migraciones" durante el loop de
    // implementación de A07–A11 (25 — todas de TASK-db/TASK-auth), y ese
    // loop ya cerró. La 26ª (`08_seed_equity_only`) es una migración
    // nueva, explícitamente autorizada y aplicada con `migrate deploy`
    // (nunca `migrate dev`/`db push`) para reducir `fn_seed_new_user` a
    // la cuenta de sistema — el número se actualiza a propósito, no es
    // que el guardrail haya dejado de importar: sigue atajando cualquier
    // migración que aparezca sin que alguien la haya pedido.
    const EXPECTED_MIGRATION_COUNT = 26;

    const migrationsDir = join(REPO_ROOT, 'prisma/migrations');
    const actualCount = readdirSync(migrationsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
    expect(actualCount).toBe(EXPECTED_MIGRATION_COUNT);

    const output = execFileSync('npx', ['dotenv', '-e', '.env', '--', 'npx', 'prisma', 'migrate', 'status'], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    });
    expect(output).toContain('Database schema is up to date!');
  });
});
