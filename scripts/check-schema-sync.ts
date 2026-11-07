import { readFileSync } from 'node:fs';
import { Client } from 'pg';

/**
 * Verifica que `prisma/schema.prisma` siga reflejando las tablas reales,
 * escritas a mano (sin `migrate dev` — TASK-db.md §3). NO usa ninguna
 * herramienta de diff de Prisma (`migrate diff`, `db pull`): todas
 * necesitan que Prisma introspeccione la base, y la FK cruzada
 * `public.profiles → auth.users` obliga a `multiSchema`, que a su vez
 * hace que Prisma trate `auth` como un schema que gestiona y lo borra en
 * cualquier `migrate reset` — probado, rompe /verify. Ver TASK-auth.md,
 * "shadowDatabaseUrl: probado y descartado".
 *
 * En su lugar: parseo simple de `model { ... }` en schema.prisma
 * (nombre de tabla vía `@@map`, columnas vía `@map` o el nombre del
 * campo) comparado contra `information_schema.columns` leído con `pg`
 * directo — sin pasar por el motor de introspección de Prisma en
 * absoluto, así que no puede disparar el problema de arriba.
 *
 * Comprueba únicamente el `public` schema — nunca se compara contra
 * `auth`.
 */

interface ParsedModel {
  modelName: string;
  tableName: string;
  columns: string[];
}

interface ParsedEnum {
  enumName: string;
  typeName: string;
  values: string[];
}

function parseSchema(text: string): ParsedModel[] {
  const models: ParsedModel[] = [];
  const modelBlocks = text.matchAll(/model\s+(\w+)\s*\{([^}]*)\}/g);

  for (const match of modelBlocks) {
    const [, modelName, body] = match;
    const mapMatch = body.match(/@@map\("(\w+)"\)/);
    const tableName = mapMatch ? mapMatch[1] : modelName.toLowerCase();

    const columns: string[] = [];
    for (const line of body.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('@@') || trimmed.startsWith('//') || trimmed.startsWith('///')) {
        continue;
      }
      const fieldMatch = trimmed.match(/^(\w+)\s+\S+/);
      if (!fieldMatch) continue;
      const fieldName = fieldMatch[1];
      const columnMapMatch = trimmed.match(/@map\("(\w+)"\)/);
      columns.push(columnMapMatch ? columnMapMatch[1] : fieldName);
    }

    models.push({ modelName, tableName, columns });
  }

  return models;
}

function parseEnums(text: string): ParsedEnum[] {
  const enums: ParsedEnum[] = [];
  const enumBlocks = text.matchAll(/enum\s+(\w+)\s*\{([^}]*)\}/g);

  for (const match of enumBlocks) {
    const [, enumName, body] = match;
    const mapMatch = body.match(/@@map\("(\w+)"\)/);
    const typeName = mapMatch ? mapMatch[1] : enumName.toLowerCase();

    const values: string[] = [];
    for (const line of body.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('@@') || trimmed.startsWith('//') || trimmed.startsWith('///')) {
        continue;
      }
      const valueMatch = trimmed.match(/^(\w+)/);
      if (!valueMatch) continue;
      const valueMapMatch = trimmed.match(/@map\("(\w+)"\)/);
      values.push(valueMapMatch ? valueMapMatch[1] : valueMatch[1]);
    }

    enums.push({ enumName, typeName, values });
  }

  return enums;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('Falta DATABASE_URL en el entorno.');
    process.exit(1);
  }

  const schemaText = readFileSync('prisma/schema.prisma', 'utf-8');
  const models = parseSchema(schemaText);
  const enums = parseEnums(schemaText);

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  let hasDrift = false;

  for (const parsedEnum of enums) {
    const { rows } = await client.query(
      `SELECT e.enumlabel FROM pg_enum e
       JOIN pg_type t ON e.enumtypid = t.oid
       WHERE t.typname = $1
       ORDER BY e.enumsortorder`,
      [parsedEnum.typeName],
    );
    const realValues = rows.map((r: { enumlabel: string }) => r.enumlabel);

    if (realValues.length === 0) {
      console.error(`[FALTA] enum ${parsedEnum.enumName} (@@map("${parsedEnum.typeName}")) — el tipo no existe en la base.`);
      hasDrift = true;
      continue;
    }

    const sameOrder = realValues.length === parsedEnum.values.length && realValues.every((v, i) => v === parsedEnum.values[i]);

    if (sameOrder) {
      console.log(`[OK]    enum ${parsedEnum.enumName} (${parsedEnum.typeName}) — ${realValues.length} valores, coincide.`);
    } else {
      hasDrift = true;
      console.error(
        `[DRIFT] enum ${parsedEnum.enumName} (${parsedEnum.typeName}) — schema.prisma declara [${parsedEnum.values.join(', ')}], la base tiene [${realValues.join(', ')}]`,
      );
    }
  }

  for (const model of models) {
    const { rows } = await client.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
      [model.tableName],
    );
    const realColumns = new Set(rows.map((r: { column_name: string }) => r.column_name));
    const declaredColumns = new Set(model.columns);

    if (realColumns.size === 0) {
      console.error(`[FALTA] model ${model.modelName} (@@map("${model.tableName}")) — la tabla no existe en la base.`);
      hasDrift = true;
      continue;
    }

    const missingFromDb = model.columns.filter((c) => !realColumns.has(c));
    const missingFromSchema = [...realColumns].filter((c) => !declaredColumns.has(c));

    if (missingFromDb.length === 0 && missingFromSchema.length === 0) {
      console.log(`[OK]    model ${model.modelName} (${model.tableName}) — ${model.columns.length} columnas, coincide.`);
    } else {
      hasDrift = true;
      if (missingFromDb.length > 0) {
        console.error(`[DRIFT] model ${model.modelName} declara columnas que NO existen en "${model.tableName}": ${missingFromDb.join(', ')}`);
      }
      if (missingFromSchema.length > 0) {
        console.error(`[DRIFT] "${model.tableName}" tiene columnas que schema.prisma NO declara: ${missingFromSchema.join(', ')}`);
      }
    }
  }

  await client.end();

  if (hasDrift) {
    console.error('\nSCHEMA.PRISMA DESINCRONIZADO — ver líneas [DRIFT]/[FALTA] arriba.');
    process.exit(1);
  }

  console.log(
    `\nschema.prisma en sync con la base (${models.length} modelo(s), ${enums.length} enum(s) verificados, solo schema public).`,
  );
}

main().catch((err) => {
  console.error('Error corriendo check-schema-sync:', err);
  process.exit(1);
});
