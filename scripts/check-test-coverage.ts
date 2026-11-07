import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * Verificación de cobertura de IDs de TASK-db.md §5 — DISTINTA del script
 * de paridad (`db-parity-check.ts`, T-L04), que compara la base de datos
 * contra el catálogo esperado. Este script compara el CÓDIGO DE TESTS
 * contra la lista de IDs (T-A01…T-N06), y a diferencia de un `grep` de
 * strings únicas, cuenta lo que Jest REALMENTE ejecuta.
 *
 * Por qué el `grep -o | sort -u` no sirve como verificación: un ID
 * mencionado en un comentario o docstring cuenta igual que uno con un
 * `it()` real; un `it.each` con varios casos y un solo ID en el título se
 * deduplica a 1 aunque Jest corra N tests; y si una suite completa falla
 * al cargar (`@prisma/client did not initialize`, un `import` roto, etc.)
 * sus IDs desaparecen de lo que Jest reporta sin que el texto fuente lo
 * refleje. Ninguno de esos tres casos es "cobertura faltante" en el mismo
 * sentido — por eso se reportan en categorías separadas.
 *
 * Categorías por ID:
 *   RAN_PASS      — Jest ejecutó un test real con ese ID y pasó
 *   RAN_FAIL      — Jest ejecutó un test real con ese ID y falló (el
 *                   estado esperado mientras no exista la implementación)
 *   SUITE_CRASHED — el ID está en el código (un it() real), pero su
 *                   archivo entero no cargó (error de compilación o de
 *                   construcción antes del primer test) — Jest no llegó
 *                   a contarlo
 *   MISSING       — el ID no aparece en ningún it()/it.each() de ningún
 *                   archivo de test. Esta es la única categoría que
 *                   debería bloquear: si aparece alguna, el script sale
 *                   con código 1.
 */

// TASK-db.md §5 — lista canónica, Grupo L completo (8 IDs, T-L01..T-L08).
const GROUP_COUNTS: Record<string, number> = {
  A: 10, B: 3, C: 12, D: 15, E: 12, F: 13, G: 23,
  H: 6, I: 8, J: 6, K: 3, L: 8, M: 4, N: 6,
};
// T-L04 (script de paridad) vive en scripts/db-parity-check.ts, no en un
// .spec.ts — se excluye del barrido de it() y se verifica aparte, fijo,
// contra ese archivo específico.
const PARITY_SCRIPT_PATH = 'scripts/db-parity-check.ts';
const PARITY_SCRIPT_ID = 'T-L04';

function expectedIds(): string[] {
  const ids: string[] = [];
  for (const [group, count] of Object.entries(GROUP_COUNTS)) {
    for (let i = 1; i <= count; i += 1) {
      const id = `T-${group}${String(i).padStart(2, '0')}`;
      if (id === PARITY_SCRIPT_ID) continue;
      ids.push(id);
    }
  }
  return ids;
}

interface JestAssertion {
  fullName: string;
  status: string;
}

interface JestSuiteResult {
  name: string;
  status: string;
  message: string;
  assertionResults: JestAssertion[];
}

interface JestRunResult {
  testResults: JestSuiteResult[];
}

function runJest(): JestRunResult {
  let raw: string;
  try {
    // --config: usa el mismo config que test:integration:* (globalSetup
    // aplica el stub de auth.users) — sin esto, una vez que fixture.ts
    // inserta en auth.users primero, todo fallaría por "relation
    // auth.users does not exist" en vez de la razón real.
    raw = execFileSync(
      'npx',
      ['jest', '--config', 'test/jest-integration.config.js', '--json', '--silent', '--runInBand'],
      {
        cwd: process.cwd(),
        encoding: 'utf-8',
        env: process.env,
        maxBuffer: 64 * 1024 * 1024,
      },
    );
  } catch (err) {
    // Jest sale con código != 0 cuando hay tests en rojo — es el caso
    // normal en esta fase. execFileSync lanza igual, pero el JSON viene
    // en stdout del error.
    const e = err as { stdout?: string };
    if (!e.stdout) {
      throw err;
    }
    raw = e.stdout;
  }
  return JSON.parse(raw) as JestRunResult;
}

function idsInText(text: string): Set<string> {
  const titleMatches = [...text.matchAll(/\bit(?:\.each\([^)]*\))?\(\s*['"`]([^'"`]*)['"`]/g)];
  const ids = new Set<string>();
  for (const match of titleMatches) {
    for (const id of match[1].matchAll(/T-[A-Z]\d{2}/g)) {
      ids.add(id[0]);
    }
  }
  return ids;
}

function main(): void {
  const expected = expectedIds();
  const run = runJest();

  const ranStatusById = new Map<string, 'passed' | 'failed'>();
  const crashedFiles: Array<{ file: string; message: string }> = [];

  for (const suite of run.testResults) {
    const hasRealResults = suite.assertionResults.length > 0;
    if (!hasRealResults) {
      crashedFiles.push({ file: suite.name, message: (suite.message || '').split('\n')[0] });
      continue;
    }
    for (const assertion of suite.assertionResults) {
      for (const idMatch of assertion.fullName.matchAll(/T-[A-Z]\d{2}/g)) {
        const id = idMatch[0];
        const status = assertion.status === 'passed' ? 'passed' : 'failed';
        // Si un mismo ID corre más de una vez (it.each), cualquier fallo domina.
        const prev = ranStatusById.get(id);
        ranStatusById.set(id, prev === 'failed' ? 'failed' : status);
      }
    }
  }

  const crashedIds = new Set<string>();
  for (const { file } of crashedFiles) {
    const text = readFileSync(file, 'utf-8');
    for (const id of idsInText(text)) {
      crashedIds.add(id);
    }
  }

  const buckets = { RAN_PASS: [] as string[], RAN_FAIL: [] as string[], SUITE_CRASHED: [] as string[], MISSING: [] as string[] };

  for (const id of expected) {
    const ran = ranStatusById.get(id);
    if (ran === 'passed') {
      buckets.RAN_PASS.push(id);
    } else if (ran === 'failed') {
      buckets.RAN_FAIL.push(id);
    } else if (crashedIds.has(id)) {
      buckets.SUITE_CRASHED.push(id);
    } else {
      buckets.MISSING.push(id);
    }
  }

  console.log(`Esperados (TASK-db.md §5, excluyendo T-L04 de script): ${expected.length}`);
  console.log(`  RAN_PASS      (Jest corrió y pasó):            ${buckets.RAN_PASS.length}`);
  console.log(`  RAN_FAIL      (Jest corrió y falló):           ${buckets.RAN_FAIL.length}`);
  console.log(`  SUITE_CRASHED (archivo no cargó):              ${buckets.SUITE_CRASHED.length}`);
  console.log(`  MISSING       (no está en ningún it()):        ${buckets.MISSING.length}`);

  if (buckets.RAN_PASS.length > 0) {
    console.log(`\nPasando ahora mismo (revisar si es legítimo o falso positivo):`);
    console.log('  ' + buckets.RAN_PASS.join(', '));
  }

  if (crashedFiles.length > 0) {
    console.log(`\nArchivos que no cargaron (sus IDs no corrieron ningún test real):`);
    for (const { file, message } of crashedFiles) {
      console.log(`  ${file}\n    → ${message}`);
    }
  }

  const parityScriptText = readFileSync(PARITY_SCRIPT_PATH, 'utf-8');
  const parityScriptHasId = parityScriptText.includes(PARITY_SCRIPT_ID);
  console.log(
    `\n${PARITY_SCRIPT_ID} (verificado aparte, vive en ${PARITY_SCRIPT_PATH}, no en un .spec.ts): ${
      parityScriptHasId ? 'presente' : 'AUSENTE'
    }`,
  );

  const missing = buckets.MISSING.length + (parityScriptHasId ? 0 : 1);
  if (missing > 0) {
    if (buckets.MISSING.length > 0) {
      console.log(`\nIDs sin ningún it() en ningún archivo:`);
      console.log('  ' + buckets.MISSING.join(', '));
    }
    console.error(`\nCOBERTURA INCOMPLETA: ${missing} ID(s) de TASK-db.md no tienen ningún test escrito.`);
    process.exit(1);
  }

  console.log(`\nCobertura de IDs completa: los ${expected.length + 1} IDs de TASK-db.md §5 están cubiertos (${expected.length} en it() reales + ${PARITY_SCRIPT_ID} en el script de paridad).`);
}

main();
