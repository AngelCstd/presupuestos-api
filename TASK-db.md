# TASK-db.md

> **Destinatario:** agente autónomo implementando sin supervisión turno por turno.
> **Fuente de verdad del diseño:** `ARCHITECTURE.md`, §3.1–§3.15. Este documento describe **qué construir, en qué orden, y cómo verificar cada pieza**. No repite las justificaciones. Ante cualquier ambigüedad, `ARCHITECTURE.md` manda.

---

# 0. Condición de paro

**La tarea está terminada cuando estos tres comandos, ejecutados en este orden sobre el contenedor de tests, terminan los tres con código de salida `0`:**

```bash
npx prisma migrate reset --force --skip-seed
npx prisma migrate status          # debe imprimir: "Database schema is up to date!"
npm run test:integration && npm run test:unit
```

**Condición binaria. No hay juicio involucrado.** Si los tres comandos salen en `0`, la tarea está hecha. Si cualquiera sale distinto de `0`, no lo está.

**Reglas de operación del loop:**

1. **No se avanza de unidad con tests en rojo.** Cada unidad U00–U24 tiene su lista de tests; se cierran todos antes de pasar a la siguiente.
2. **No se marca una unidad como hecha modificando o borrando un test para que pase.** Si un test falla, se arregla la implementación, no el test. Si el test parece estar mal, es una decisión → §7 (detenerse y preguntar).
3. **No se declara la tarea terminada sin correr los tres comandos completos**, aunque los tests de la última unidad estén en verde.
4. **Cualquier `TODO`, `@ts-ignore`, `it.skip`, `it.todo` o test comentado en el código entregado significa que la tarea NO está terminada.**

**Verificación adicional obligatoria antes de declarar el paro** (T-L03 y T-L04 la cubren, pero se enuncia aquí porque es la trampa final): `migrate reset` debe reproducir **triggers y funciones**, no solo tablas. Si un trigger existe en la base pero no en una migración, `reset` lo borra y los tests que dependían de él fallan. Ese fallo es la señal correcta y no debe "arreglarse" recreando el objeto a mano.

---

# 1. Alcance

**Dentro:** seis tablas, tres enums, once reglas de integridad (R1–R11, con R9 en dos puntos de disparo), cuatro funciones de consulta, policies RLS (desplegadas, **no testeadas**), extensiones, función de seeds, y la función pura de `nextDueOn`.

**Fuera:** cualquier `Service`, `Controller`, `Repository`, DTO o endpoint (salvo la función pura de U08b y los helpers de U23); **tests de RLS**; tools del MCP; onboarding y UI; multi-moneda; columnas de `profiles`; cualquier PENDIENTE de §3.14.

---

# 2. Cómo está organizada esta tarea

El trabajo está partido en **unidades (U00–U24)**. Cada unidad es independiente (se verifica sin las posteriores), atómica (una migración o un artefacto) y trae su lista exacta de tests.

### Sobre "test unitario" en una capa de datos

| Tipo | Qué cubre aquí | ¿Necesita DB? |
|---|---|---|
| **Unitario puro** ⭐ | `nextDueOn` (U08b), serialización de `BigInt`, reparto de residuo en splits (U23) | No |
| **Integración acotada** | Cada trigger y cada función SQL, probados en aislamiento | Sí |
| **Integración de flujo** | Reversa completa, efectos del cierre de periodo | Sí |

La mayor parte de los invariantes viven en Postgres, así que no son unitariamente testeables: probar R1 sin base de datos sería probar nada. Lo que sí se logró es que **cada trigger y cada función se prueben en aislamiento**, que es el equivalente práctico.

**Excepción deliberada:** la regla de `nextDueOn` (§3.3) se implementa como **función pura de TypeScript**, no en SQL, precisamente para que sea unitariamente testeable sin infraestructura.

---

# 3. Grafo de dependencias de migraciones

El orden **no es una preferencia**. Cada arista existe porque la migración destino falla al aplicarse sin la origen. **Si una migración falla, no reordenar: leer la columna "qué se rompe si se adelanta" y corregir la causa.**

| # | Migración | Qué crea | Depende de | Qué se rompe si se adelanta |
|---|---|---|---|---|
| — | *(de `TASK-auth`)* | `profiles` | — | **Todas** las tablas de esta capa tienen FK a `profiles.id`. Sin ella, `02a` en adelante fallan con `42P01 relation does not exist` |
| 00 | `00_extensions` | `pgcrypto`, `btree_gist` | — | Sin `pgcrypto`, todo `DEFAULT gen_random_uuid()` falla con `42883 function does not exist`. Sin `btree_gist`, `03_period_exclusion` falla con `42704 data type uuid has no default operator class for access method gist` |
| 01 | `01_enums` | `account_type`, `rollover_type`, `budget_entry_source` | 00 | Las columnas `type` y `rollover_type` de `accounts` no se pueden declarar. `42704 type does not exist` |
| 02a | `02a_accounts` | tabla `accounts` + CHECKs + índice único parcial | 01, `profiles` | `entries`, `budget_entries` y `recurring_templates` referencian `accounts.id`. Sin ella, `42P01` |
| 02b | `02b_budget_periods` | tabla `budget_periods` (**sin** el EXCLUDE) | 01, `profiles` | `budget_entries` referencia `period_id`. `42P01` |
| 02c | `02c_transactions` | tabla `transactions` + FK autorreferencial + índices únicos parciales | `profiles` | `entries` referencia `transaction_id`. `42P01` |
| 02d | `02d_entries` | tabla `entries` + CHECK de monto | 02a, 02c, `profiles` | Todas las funciones de §3.9 agregan sobre `entries`. Sin ella, `05a`–`05d` fallan |
| 02e | `02e_budget_entries` | tabla `budget_entries` + índice único parcial de rollover | 02a, 02b, `profiles` | `05b` y `05c` la consultan |
| 02f | `02f_recurring_templates` | tabla `recurring_templates` + CHECKs | 02a, `profiles` | Ninguna otra migración depende de ella; es hoja del grafo |
| 03 | `03_period_exclusion` | constraint `budget_periods_no_overlap` | 00 (`btree_gist`), 02b | **Separada de 02b a propósito.** Si se mete dentro de 02b y `btree_gist` no está, falla toda la creación de la tabla en vez de solo el constraint, y el diagnóstico se vuelve confuso |
| 04a | `04a_entries_deferred_checks` | R1 + R2 + R4 (función + constraint trigger diferido) | 02a, 02c, 02d | La función lee `entries`, `transactions` y `accounts.currency`. Sin las tres, `42P01` en tiempo de ejecución del trigger, no de creación |
| 04b | `04b_entries_owner_consistency` | R3 | 02a, 02c, 02d | Igual que 04a |
| 04c | `04c_ledger_immutability` | R5 + R6 | 02c, 02d | — |
| 04d | `04d_reversal_magnitude` | R9, **dos triggers** | 02c, 02d, 04a | Reusa la función diferida de 04a; si se adelanta, `42883` |
| 04e | `04e_budget_entry_category` | R7 | 02a, 02e | — |
| 04f | `04f_archive_zero_balance` | R8 | 02a, 02d | Lee el saldo derivado de `entries` |
| 04g | `04g_closed_period_locks` | R10 + R11 | 02b, 02e | R11 lee `budget_periods.closed_at` desde `budget_entries` |
| 05a | `05a_fn_account_balances` | F1 | 02a, 02d | Agrega `entries` por `accounts` |
| 05b | `05b_fn_category_balances` | F2 | 02a, 02b, 02d, 02e | Cruza las cuatro |
| 05c | `05c_fn_unassigned_funds` | F3 | 02a, 02b, 02d, 02e | Cruza las cuatro. **Después de 05b**: reusa el mismo cálculo de `disponible` |
| 05d | `05d_fn_transactions_without_period` | F4 | 02b, 02c | — |
| 06 | `06_rls` | `ENABLE RLS` + 24 policies | 02a–02f | Una policy sobre tabla inexistente falla con `42P01` |
| 07 | `07_seed_function` | `fn_seed_new_user` | 01, 02a | **Al final a propósito.** Inserta filas reales; si corre antes de que existan los CHECKs de 02a, sembraría datos que violan constraints que se agregan después, y la migración siguiente falla al aplicar el constraint sobre datos existentes |
| 08 | `08_seed_equity_only` | Reemplaza `fn_seed_new_user` vía `CREATE OR REPLACE` — reduce el seed a la cuenta de sistema | 07 | Decisión revisada tras verificar contra Supabase real (P-07): las 7 categorías y "Sueldo" dejan de sembrarse automáticamente y pasan a ser sugerencia del frontend. La cuenta de sistema se mantiene: es infraestructura que el usuario no puede crear |

**Reglas transversales del grafo:**

- **Extensiones siempre primero.** `pgcrypto` lo usan todos los `DEFAULT`; `btree_gist` solo el `EXCLUDE`, pero se instalan juntas para no fragmentar.
- **Enums antes de tablas.** Postgres no permite declarar una columna de un tipo inexistente.
- **`profiles` antes de todo.** Es de `TASK-auth`. Ver §8 para qué hacer si no existe.
- **Funciones (05x) después de todas las tablas** que consultan. Postgres valida el cuerpo de una función `LANGUAGE sql` al crearla; una tabla faltante hace fallar el `CREATE FUNCTION`, no la primera invocación.
- **Seeds al final.** Siempre.

**Flujo obligatorio de cada migración — a mano, nunca con `migrate dev`:**

⚠️ **`prisma migrate dev` está prohibido, con o sin `--create-only`** (ver
§7.2). Con `auth.users` fuera de la cadena de migraciones de Prisma
(decisión de `TASK-auth`), cualquier comando de la familia `migrate dev`
usa una shadow database sin esa tabla y falla — verificado empíricamente,
detalle completo en `TASK-auth.md` → "`shadowDatabaseUrl`: probado y
descartado". No es un caso raro: pasa desde la **segunda** migración del
proyecto en adelante, o sea desde `01_enums`.

```bash
# 1. Timestamp UTC, formato exacto que usa Prisma (14 dígitos, sin separadores)
date -u +%Y%m%d%H%M%S
# ej. 20260806120000

# 2. Crear la carpeta con ese timestamp + el nombre de la migración de la tabla del grafo (arriba)
mkdir -p prisma/migrations/20260806120000_00_extensions

# 3. Escribir el SQL COMPLETO a mano en migration.sql. Ya no hay generación
#    automática de la parte declarativa (tablas, columnas, enums, FKs
#    simples) — antes la generaba `migrate dev --create-only` y solo se
#    editaba encima para agregar triggers/funciones/policies/índices
#    parciales/EXCLUDE. Ahora TODO el SQL de la migración, declarativo
#    incluido, se escribe en este único archivo.
$EDITOR prisma/migrations/20260806120000_00_extensions/migration.sql

# 4. Reflejar a mano en prisma/schema.prisma lo que SÍ es representable ahí:
#    tablas, columnas, tipos, enums, índices simples, FKs simples (dentro
#    de las 6 tablas de esta capa — nunca declarar una relación hacia
#    auth.users, ver nota abajo). Prisma no lo va a inferir del SQL: si no
#    se edita aquí, se desincroniza en silencio.
#    Triggers, funciones, RLS, índices parciales y EXCLUDE NO se declaran
#    en schema.prisma — no tiene sintaxis para eso. Viven solo en el SQL.

# 5. Aplicar — únicamente así:
npx prisma migrate deploy

# 6. Verificar que schema.prisma sigue reflejando la base real:
npm run db:check-sync
```

**Por qué el paso 6 no es opcional.** Antes, `migrate dev` generaba
`schema.prisma` y la migración desde el mismo lugar — no se podían
desincronizar. Ahora se escriben por separado, a mano, y nada los ata
automáticamente. Un `model` desactualizado no lo detecta ningún test de
esta suite (hablan SQL crudo contra la base, no pasan por Prisma Client,
salvo T-M01) — el primer síntoma sería un error de tipos confuso mucho
después, en la capa de Services. El paso 6 es la única red de seguridad
contra eso.

**`npm run db:check-sync` (`scripts/check-schema-sync.ts`) — por qué NO
usa ninguna herramienta de diff de Prisma.** `migrate diff`/`db pull`
necesitan introspeccionar la base, y la FK cruzada
`public.profiles → auth.users` obliga a activar `multiSchema` para que
Prisma tolere esa referencia. **Probado y descartado:** con `multiSchema`
activo, Prisma trata `auth` como un schema que gestiona, y lo borra en
**cualquier** `migrate reset` — no solo en la shadow database de
`migrate dev` — rompiendo el paso 2 de `/verify` por completo. El script
en su lugar parsea `model { ... }` de `schema.prisma` (nombre de tabla
vía `@@map`, columnas vía `@map` o el nombre del campo) y lo compara
contra `information_schema.columns`, leído con `pg` directo — sin pasar
por el motor de introspección de Prisma en absoluto. Compara únicamente
el schema `public`; nunca toca ni compara contra `auth`.

**Nota permanente sobre `auth.users`:** ningún modelo de `schema.prisma`
debe declarar una relación de Prisma hacia `auth.users` — ni siquiera
para tipar el cliente. Ya se probó (ver `TASK-auth.md`) y el costo
(`multiSchema` rompiendo `migrate reset`) es mayor que el beneficio. La
FK real vive solo en el SQL de la migración de `profiles`.

---

# 4. Unidades de trabajo

## U00 — Infraestructura de tests

Suite de integración contra el Postgres local de Docker (D2), con helpers de:
- apertura/rollback de transacción por test (aislamiento entre casos)
- **aserción de `ERRCODE` exacto** (no de `throws` genérico)
- **aserción de "estado intacto"**: snapshot de conteos antes y después de un fallo esperado
- **helper de `COMMIT` explícito** — indispensable para los triggers diferidos, ver §5.1

**Hecho cuando:** un test de humo inserta y hace rollback, el helper distingue `23514` de `23505`, y el helper de `COMMIT` permite provocar el error al cerrar la transacción y no al insertar.

**Bloquea a:** todas las demás unidades.

## U01 — Extensiones · migración `00_extensions`
Tests: T-L01. **Hecho cuando:** `SELECT gen_random_uuid()` funciona y un `EXCLUDE USING gist` de prueba se puede crear.

## U02 — Enums · `01_enums`
Tests: T-L02. **Hecho cuando:** los tres tipos existen con sus valores exactos, incluido `receivable`.

## U03 — Tabla `accounts` · `02a_accounts`
Constraints: `accounts_rollover_consistency`, `accounts_currency_format`, `accounts_system_is_equity`, índice único parcial `(user_id, lower(name)) WHERE archived_at IS NULL`, FK `user_id → profiles.id` con **`ON DELETE RESTRICT`**.
Tests: T-D01…T-D08, T-D15, T-L07.

## U04 — `budget_periods` + EXCLUDE · `02b`, `03`
El predicado `WHERE (deleted_at IS NULL)` del `EXCLUDE` **no es opcional**.
Tests: T-E01…T-E08.

## U05 — Tabla `transactions` · `02c_transactions`
Índices únicos parciales de reversa e idempotencia. **Sin columna `deleted_at`.**
Tests: T-C10, T-C12, T-H01…T-H06, T-J03.

## U06 — Tabla `entries` · `02d_entries`
`bigint` + `CHECK (amount_cents <> 0)`. Las tres FKs con `ON DELETE RESTRICT`. **Sin `deleted_at`.**
Tests: T-A07, T-D14, T-J03, T-M01.

## U07 — Tabla `budget_entries` · `02e_budget_entries`
`CHECK (amount_cents <> 0)` (permite negativos). Índice único parcial de rollover.
Tests: T-F05…T-F09.

## U08a — Tabla `recurring_templates` · `02f_recurring_templates`
Tests: T-I07, T-I08, T-J06.

## U08b — Función pura `nextDueOn` ⭐ *sin base de datos*

```ts
nextDueOn(dayOfMonth: number, lastConfirmedOn: Date): Date
```

Si `dayOfMonth` no existe en el mes objetivo → **primer día del mes siguiente**. El cálculo parte siempre de `dayOfMonth` aplicado al mes objetivo, nunca de `nextDueOn + 1 mes`.

**Cuál es el mes objetivo** — se decide comparando el día de `lastConfirmedOn` contra `dayOfMonth`:

| Condición | Mes objetivo |
|---|---|
| `día(lastConfirmedOn) < dayOfMonth` | El **mismo** mes de `lastConfirmedOn` |
| `día(lastConfirmedOn) >= dayOfMonth` | El mes **siguiente** al de `lastConfirmedOn` |

No es siempre "el mes siguiente". Un usuario puede confirmar con retraso, ya entrado el mes posterior al del vencimiento: con `dayOfMonth = 31` y confirmación el 1 de marzo, como `1 < 31` el mes objetivo es marzo y el resultado es el 31 de marzo. Si fuera siempre el mes siguiente, saltaría a abril y se perdería un ciclo completo. Es el caso de T-I06.
Tests: T-I01…T-I06. Corren sin Docker.

## U09 — R1 + R2 + R4 · `04a_entries_deferred_checks`

Un solo `CONSTRAINT TRIGGER ... AFTER INSERT OR UPDATE OR DELETE ON entries ... DEFERRABLE INITIALLY DEFERRED` con las tres validaciones.

**R1 trata `SUM(...) IS NULL` como aprobado:**
```sql
SELECT SUM(amount_cents) INTO v_total FROM entries WHERE transaction_id = v_tx_id;
IF v_total IS NOT NULL AND v_total <> 0 THEN
  RAISE EXCEPTION 'Ledger desbalanceado: %', v_total USING ERRCODE = 'P1001';
END IF;
```

**Orden de evaluación obligatorio: R2 antes que R1.**
Un solo entry siempre está desbalanceado, así que si R1 se evalúa primero, le gana a R2 y devuelve `P1001` (desbalance genérico) donde debería salir `P1002` (un solo entry). El mensaje específico queda tapado por el genérico. `ARCHITECTURE.md` §3.4 ya lo advierte al justificar R2: *"validarlo explícitamente da un mensaje claro en vez de uno confuso desde R1"* — pero ese racional solo se cumple si R2 va primero dentro de la función. Es el caso de T-A06.

Tests: T-A01…T-A08, T-A10.

## U10 — R3 · `04b_entries_owner_consistency`
`BEFORE INSERT OR UPDATE`, **inmediato**. Tests: T-B01…T-B03.

## U11 — R5 + R6 · `04c_ledger_immutability`
R5 sin excepciones. R6 permite solo `UPDATE` de `description`. Tests: T-C01…T-C06, T-A09.

## U12 — R9, dos disparos · `04d_reversal_magnitude`
Magnitud = `SUM(amount_cents) FILTER (WHERE amount_cents > 0)`. Segundo trigger sobre `transactions` (`AFTER INSERT`, diferido, solo si `reverses_transaction_id IS NOT NULL`).
Tests: T-C07…T-C09, T-C11, T-L08.

## U13 — R7 · `04e_budget_entry_category`
Tests: T-F01…T-F04.

## U14 — R8 · `04f_archive_zero_balance`
Solo `asset`, `receivable`, `liability`. Tests: T-D09…T-D13.

## U15 — R10 + R11 · `04g_closed_period_locks`
R11 dispara `BEFORE INSERT OR UPDATE OR DELETE`. **`INSERT` no es opcional:** sin él, un periodo cerrado admitiría presupuesto nuevo aunque no se pudiera modificar el existente — la regla sería "medio inmutable". Es además lo que hace verdadero el comportamiento que espera T-N06 (`ARCHITECTURE.md` §3.10 describe el cierre desordenado diciendo que *"el insert del rollover lo bloquea R11"*). Incluye el soft delete y no tiene excepciones. Tests: T-E09…T-E12, T-F10…T-F13.

## U16 — F1 · `05a_fn_account_balances`
`LEFT JOIN` obligatorio. **Incluye cuentas archivadas.** Tests: T-G01…T-G03, T-G20.

## U17 — F2 · `05b_fn_category_balances`
Devuelve `has_budget boolean`. **Incluye categorías archivadas.** Tests: T-G04…T-G10, T-G21.

## U18 — F3 ⚠️ *la unidad más delicada* · `05c_fn_unassigned_funds`

**Firma de un solo parámetro: `fn_unassigned_funds(p_user_id uuid)`.**

```
sin_asignar = dinero_real − comprometido

dinero_real  = Σ saldo(asset) + Σ saldo(liability)     -- histórico completo, incluye archivadas
comprometido = Σ GREATEST(disponible_cp, 0)
             + Σ ABS(LEAST(disponible_cp, 0))
```

sobre todos los pares `(categoría, periodo)` donde el periodo tiene `closed_at IS NULL AND deleted_at IS NULL`.

**Tres formas de romperla, las tres pasan el camino feliz:**

| Error | Reintroduce | Test que lo detecta |
|---|---|---|
| `SUM(asignado) − SUM(gastado)` | Fallo B (sobregiro fantasma) | **T-G14** |
| Incluir periodos cerrados | Fallo A (rollover doble) | **T-G17** |
| Agregar por categoría colapsando periodos | Variante de Fallo B | **T-G16** |

Tests: T-G11…T-G18, T-G21, T-G22, T-G23.

## U19 — F4 · `05d_fn_transactions_without_period`
Tests: T-G19.

## U20 — RLS · `06_rls`
24 policies, `UPDATE` con `USING` **y** `WITH CHECK`. **Se despliegan pero NO se testean semánticamente.**
Tests: T-L05 (solo estructural). Verificación semántica = acción humana #17.

## U21 — Seeds · `07_seed_function` (reducida en `08_seed_equity_only`)
1 `equity` (Saldo Inicial, `is_system=true`). **Sin cuentas reales.** Idempotente.

Las 7 categorías `expense` (Comida/Transporte/Hogar/Personal → `reset`; Servicios/Salud/Ahorro → `accumulate`) y el `income` "Sueldo" **dejaron de sembrarse automáticamente** — decisión revisada al verificar contra Supabase real. Pasan a ser una lista sugerida que el frontend presenta en el onboarding, creada con los endpoints normales. Ver §3.12 del `ARCHITECTURE.md`.
Tests: T-K01, T-K01b, T-K02, T-K03.

## U22 — Fixture de datos de prueba
Dos usuarios (A y B), cada uno con: las 9 cuentas que U21 sembraba antes de reducirse a la cuenta de sistema, **insertadas directo por SQL en el fixture y nunca invocando `fn_seed_new_user`** (así fue desde el inicio: el fixture existe desde antes que la función), más `asset` "Nu", `liability` "TDC", `receivable` "Por cobrar: Fer", y dos `budget_periods` contiguos.

*Nota: esa independencia entre fixture y función de seed es la razón por la que ningún test detectó que nada invocaba `fn_seed_new_user` en producción.*
**Hecho cuando:** es determinista y reseteable entre suites.

## U23 — Tipos generados y `BigInt`
`prisma generate`; tipos TS manuales para el retorno de F1–F4; helper puro de reparto de residuo en splits.
Tests: T-M01, T-M02 ⭐, T-M03 ⭐, T-M04 ⭐.

## U24 — Reglas de Service (documental, sin migración)

Nacen de huecos estructurales de esta capa. Se transfieren al `TASK` de Services.

- **S-R1** — `transaction` + `entries` **siempre** en la misma transacción de DB. Es la única garantía contra transacciones huérfanas (los triggers viven sobre `entries`; una transacción vacía nunca los dispara). Si se incumple, una transacción huérfana con `idempotency_key` **quema esa llave** y el reintento legítimo devuelve un registro vacío.
- **S-R2** — Precondiciones del cierre: el periodo siguiente debe existir **y** tener `closed_at IS NULL`. Rechazar con `ClosedPeriodException` antes de tocar la base.
- **S-R3** — Filtro por `user_id` en cada `Repository`. RLS no está testeada y Prisma la bypassa.
- **S-R4** — `archived_at` filtra **solo** en endpoints de listado/selección; nunca en cálculos.

**Hecho cuando:** las cuatro están escritas en el `TASK` de Services. Esta unidad no entrega código.

---

# 5. Tests requeridos

Son **el criterio de verificación del loop**. Cada test especifica entrada concreta, resultado esperado y cómo se verifica.

**Convención obligatoria para todo test marcado ❌ (debe fallar):**
1. Verificar el `ERRCODE` **exacto** (no `expect(...).toThrow()` pelón).
2. Verificar que **la fila no quedó escrita**: `SELECT count(*)` antes y después, idénticos.

Un test que solo comprueba que "algo lanzó" **no cumple** y la unidad no se cierra.

## 5.1 ⚠️ Triggers diferidos: el error llega en el `COMMIT`, no en el `INSERT`

**Esta es la trampa número uno de esta implementación.** Léela antes de escribir un solo test.

**R1, R2, R4 y R9 son `DEFERRABLE INITIALLY DEFERRED`.** Postgres evalúa esos triggers **al cerrar la transacción**, no en cada `INSERT`. Un test escrito así **falla aunque el trigger esté perfectamente implementado**:

```ts
// ❌ MAL — el INSERT no lanza nada; el error aparece después
await expect(
  db.query(`INSERT INTO entries (...) VALUES (...)`)
).rejects.toThrow();
```

La forma correcta abre la transacción, inserta sin esperar error, y **espera el fallo en el `COMMIT`**:

```ts
// ✅ BIEN
await db.query('BEGIN');
await db.query(`INSERT INTO transactions (...) VALUES (...)`);
await db.query(`INSERT INTO entries (...) VALUES (... 70000)`);
await db.query(`INSERT INTO entries (...) VALUES (... -60000)`);
await expectErrcode(() => db.query('COMMIT'), 'P1001');   // ← aquí
// tras el rollback automático: conteos idénticos a los previos
```

**Consecuencias prácticas que el agente debe respetar:**

- **No usar el helper de rollback-por-test para los casos diferidos.** Ese helper nunca hace `COMMIT`, así que el trigger jamás se dispara y **el test pasa por construcción sin probar nada**. Los casos de R1/R2/R4/R9 necesitan una transacción propia que sí llegue al `COMMIT`.
- **Los inmediatos son al revés.** R3, R5, R6, R7, R8, R10, R11 y todos los `CHECK` lanzan en el statement. Ahí sí se espera el error en el `INSERT`/`UPDATE`.
- **T-A08 existe precisamente para verificar que el diferimiento funciona.** Si T-A08 falla, alguien convirtió el trigger en inmediato. Si T-A03 pasa pero T-A08 falla, la implementación está mal aunque los demás tests estén en verde.

| Regla | Timing | Dónde se espera el error |
|---|---|---|
| R1, R2, R4, R9 | diferido | `COMMIT` |
| R3, R5, R6, R7, R8, R10, R11 | inmediato | statement (R11 tambien en INSERT) |
| CHECKs, índices únicos, FKs, EXCLUDE | inmediato | statement |

## 5.2 Un test de rechazo por cada regla R1–R11

Tabla de referencia rápida. El detalle de cada uno está en los grupos de abajo.

| Regla | Test | Entrada concreta | ERRCODE | No debe pasar |
|---|---|---|---|---|
| R1 | T-A03 | entries `[+70000, −60000]` | `P1001` | que quede la tx ni ningún entry |
| R2 | T-A06 | un solo entry `[+70000]` | `P1002` | que quede el entry |
| R3 | T-B01 | entry `user_id=B` sobre tx de A | `P1003` | que quede el entry |
| R4 | T-A10 | entries contra cuenta MXN y cuenta USD | `P1004` | que quede la tx |
| R5 | T-C02 | `DELETE FROM entries WHERE id=<existente>` | `P1005` | que el entry desaparezca |
| R6 | T-C03 | `UPDATE transactions SET booked_at=...` | `P1006` | que cambie `booked_at` |
| R7 | T-F01 | `budget_entry` con `category_id` de cuenta `asset` | `P1007` | que quede la fila |
| R8 | T-D09 | archivar `asset` con saldo `+50000` | `P1008` | que se setee `archived_at` |
| R9 | T-C09 | reversa de magnitud `60000` sobre original de `70000` | `P1009` | que quede la reversa |
| R10 | T-E09 | `UPDATE budget_periods SET starts_on=...` con `closed_at` no nulo | `P1010` | que cambien las fechas |
| R11 | T-F10 | `UPDATE budget_entries SET amount_cents=...` en periodo cerrado | `P1011` | que cambie el monto |

## Grupo A — Suma cero (U09)

| ID | Entrada | Esperado | Cómo se verifica |
|---|---|---|---|
| T-A01 | tx + entries `[Nu −70000, Wifi +70000]`, `COMMIT` | ✅ | 1 fila en `transactions`, 2 en `entries`; `fn_account_balances` da `Nu −70000`, `Wifi +70000` respecto al estado previo |
| T-A02 | entries `[TDC −80000, Comida +40000, PorCobrar +40000]` | ✅ | 3 entries; los tres saldos cambian exactamente |
| T-A03 | entries `[+70000, −60000]` | ❌ `P1001` **en el `COMMIT`** | conteos de `transactions` y `entries` idénticos a los previos |
| T-A04 | entries `[+60000, −70000]` | ❌ `P1001` en el `COMMIT` | idem |
| T-A05 | tx **sin ningún entry**, `COMMIT` | ✅ **éxito** | la fila de `transactions` existe; 0 entries. *Si falla, R1 trata `NULL` como violación* |
| T-A06 | un solo entry `[+70000]` | ❌ `P1002` en el `COMMIT` | el código debe ser `P1002`, **no** `P1001` |
| T-A07 | entry con `amount_cents = 0` | ❌ `23514` **en el `INSERT`** (CHECK, inmediato) | — |
| T-A08 | dentro de `BEGIN`: insertar solo `[+70000]`, **sin `COMMIT`**; luego insertar `[−70000]`; `COMMIT` | ✅ sin error en el primer `INSERT`; el `COMMIT` pasa | *Discriminante del diferimiento. Si el primer `INSERT` lanza, el trigger es inmediato* |
| T-A09 | `DELETE` de un entry de una tx válida | ❌ `P1005` en el statement | el entry sigue existiendo |
| T-A10 | cuenta MXN + cuenta con `currency='USD'` en la misma tx | ❌ `P1004` en el `COMMIT` | conteos intactos |

## Grupo B — Propiedad (U10, R3)

| ID | Entrada | Esperado | Cómo se verifica |
|---|---|---|---|
| T-B01 | tx de A; entry con `user_id = B`, `account_id` de A | ❌ `P1003` **en el `INSERT`** (inmediato) | 0 entries nuevos |
| T-B02 | **tx de A; entry con `user_id = A` pero `account_id` de una cuenta de B** | ❌ `P1003` en el `INSERT` | 0 entries nuevos. *Es el test de "no puedo tocar la cuenta de otro"* |
| T-B03 | tx de A; entry con `user_id = A` y `account_id` de A | ✅ | el entry existe |

## Grupo C — Inmutabilidad y reversa (U11, U12)

| ID | Entrada | Esperado | Cómo se verifica |
|---|---|---|---|
| T-C01 | `UPDATE entries SET amount_cents = 99999` | ❌ `P1005` | el valor original sigue |
| T-C02 | `DELETE FROM entries WHERE id = <existente>` | ❌ `P1005` | la fila sigue |
| T-C03 | `UPDATE transactions SET booked_at = '2020-01-01'` | ❌ `P1006` | `booked_at` sin cambio |
| T-C04 | `UPDATE transactions SET reverses_transaction_id = <otra>` | ❌ `P1006` | sin cambio |
| T-C05 | `DELETE FROM transactions WHERE id = <existente>` | ❌ `P1006` | la fila sigue |
| T-C06 | `UPDATE transactions SET description = 'corregido'` | ✅ | el texto cambió |
| T-C07 | T1 `[Nu −70000, Wifi +70000]`; T2 con `reverses_transaction_id = T1` y `[Nu +70000, Wifi −70000]` | ✅ | `fn_account_balances` vuelve al estado previo a T1; **ambas** tx existen |
| T-C08 | T1 `[Nu −70000, Wifi +70000]`; T2 `[Efectivo +70000, Wifi −70000]` (magnitud 70000 en ambas) | ✅ **éxito** | *Si falla, R9 compara cuenta por cuenta en vez de magnitud* |
| T-C09 | T1 magnitud `70000`; T2 reversa con magnitud `60000` | ❌ `P1009` **en el `COMMIT`** | T2 no existe |
| T-C10 | T3 con `reverses_transaction_id = T1`, ya existiendo T2 | ❌ `23505` en el `INSERT` | solo hay una reversa de T1 |
| T-C11 | tx con `reverses_transaction_id = T1` y **cero entries**, `COMMIT` | ❌ **`P1009` en el `COMMIT`** | *Si pasa como éxito, falta el segundo disparo de R9. Verificar además que T1 sigue siendo revertible* |
| T-C12 | tx con `reverses_transaction_id = <su propio id>` | ❌ `23514` | — |

## Grupo D — Cuentas (U03, U14)

| ID | Entrada | Esperado |
|---|---|---|
| T-D01 | `type='expense'`, `rollover_type=NULL` | ❌ `23514` |
| T-D02 | `type='asset'`, `rollover_type='reset'` | ❌ `23514` |
| T-D03 | `type='receivable'`, `rollover_type='accumulate'` | ❌ `23514` |
| T-D04 | `type='asset'`, `is_system=true` | ❌ `23514` |
| T-D05 | dos cuentas activas del mismo usuario llamadas `'Nu'` y `'nu'` | ❌ `23505` (el índice usa `lower(name)`) |
| T-D06 | `'Nu'` activa + `'Nu'` con `archived_at` seteado | ✅ |
| T-D07 | `'Nu'` para A y `'Nu'` para B | ✅ **Acotar la aserción a los IDs del fixture**, nunca a un conteo global de la tabla. La suite comparte una sola base y los tests de triggers diferidos hacen `COMMIT` por necesidad, así que dejan filas atrás: cualquier conteo global falla de forma intermitente según qué archivos hayan corrido antes |
| T-D08 | `currency` = `'mxn'` y `'MX'` | ❌ `23514` (llegan al `CHECK`) |
| T-D08 | `currency` = `'MXNN'` | ❌ **`22001`**, no `23514`. La columna es `char(3)`: Postgres rechaza el valor por longitud excedida **antes** de que el `CHECK` se evalúe. Gana el tipo declarado en `ARCHITECTURE.md` §3.3; el test espera el código real |
| T-D09 | archivar `asset` con saldo `+50000` | ❌ `P1008`; `archived_at` sigue `NULL` |
| T-D10 | archivar `receivable` con saldo `+40000` | ❌ `P1008` |
| T-D11 | archivar `liability` con saldo `−25000` | ❌ `P1008` |
| T-D12 | **archivar `expense` "Comida" con saldo acumulado `+50000`** | ✅ **éxito**; `archived_at` queda seteado. *Discriminante de U14: si falla, R8 se aplicó a todos los tipos* |
| T-D13 | archivar `income` "Sueldo" con saldo `−1000000` | ✅ éxito |
| T-D14 | `DELETE FROM accounts` de una cuenta con entries | ❌ `23503` |
| T-D15 | archivar `asset` con saldo `0` | ✅ éxito |

## Grupo E — Periodos (U04, U15)

| ID | Entrada | Esperado |
|---|---|---|
| T-E01 | `[2026-08-01, 2026-08-15]` y `[2026-08-16, 2026-08-31]` para A | ✅ ambos |
| T-E02 | `[2026-08-01, 2026-08-15]` y `[2026-08-20, 2026-08-31]` (**hueco**) | ✅ **ambos** — no existe regla de continuidad |
| T-E03 | `[08-01, 08-15]` y `[08-15, 08-31]` | ❌ `23P01` |
| T-E04 | `[08-01, 08-31]` y `[08-10, 08-20]` | ❌ `23P01` |
| T-E05 | `[08-01, 08-15]` para A y el mismo rango para B | ✅ ambos |
| T-E06 | `[08-01, 08-15]` con `deleted_at` seteado, luego `[08-10, 08-20]` | ✅ **éxito** — *si falla, el `EXCLUDE` no lleva el predicado* |
| T-E07 | `starts_on = 08-15`, `ends_on = 08-01` | ❌ `23514` |
| T-E08 | existiendo `[08-01,08-15]` y `[08-20,08-31]`, resolver "periodo siguiente" de `[08-01,08-15]` | devuelve `[08-20,08-31]`, **no `NULL`** |
| T-E09 | `UPDATE starts_on` en periodo con `closed_at` no nulo | ❌ `P1010`; fechas sin cambio |
| T-E10 | `UPDATE ends_on` en periodo cerrado | ❌ `P1010` |
| T-E11 | `UPDATE closed_at = NULL` en periodo cerrado (reapertura) | ✅ éxito |
| T-E12 | `UPDATE starts_on` en periodo abierto | ✅ éxito |

## Grupo F — Presupuesto (U07, U13, U15)

| ID | Entrada | Esperado |
|---|---|---|
| T-F01 | `budget_entry` con `category_id` de cuenta `asset` | ❌ `P1007` |
| T-F02 | `category_id` de cuenta `income` | ❌ `P1007` |
| T-F03 | `category_id` de cuenta `receivable` | ❌ `P1007` |
| T-F04 | `category_id` de cuenta `expense` del mismo usuario | ✅ |
| T-F05 | `amount_cents = 0` | ❌ `23514` |
| T-F06 | `amount_cents = −30000` | ✅ (desasignar / arrastre de sobregiro) |
| T-F07 | dos `source='rollover'` vigentes para `(P2, Comida)` | ❌ `23505` |
| T-F08 | marcar el primer rollover con `deleted_at`, insertar otro para `(P2, Comida)` | ✅ éxito |
| T-F09 | tres `source='manual'` para `(P1, Comida)` | ✅ los tres |
| T-F10 | `UPDATE amount_cents` de un `budget_entry` en periodo cerrado | ❌ `P1011`; monto sin cambio |
| T-F11 | **`UPDATE deleted_at = now()` de un `budget_entry` en periodo cerrado** | ❌ **`P1011`** — *verifica que R11 cubre el soft delete* |
| T-F12 | `UPDATE` de un `budget_entry` con `source='rollover'` en periodo cerrado | ❌ `P1011` |
| T-F13 | `UPDATE amount_cents` en periodo abierto | ✅ éxito |

## Grupo G — Funciones de consulta (U16–U19)

Los montos van en **centavos**.

| ID | Entrada | Esperado |
|---|---|---|
| T-G01 | cuenta creada, sin entries | fila presente con `balance_cents = 0` |
| T-G02 | los nueve casos canónicos de §3.2 | saldos exactos, incluido el préstamo incobrable (`PorCobrar` a `0`, `Pérdidas` a `+50000`) |
| T-G03 | F1 de A con datos de B presentes | 0 filas de B |
| T-G04 | asignar `100000`, gastar `30000` | `disponible = 70000`, `has_budget = true` |
| T-G05 | asignar `100000`, gastar `120000` | `disponible = −20000`, `has_budget = true` |
| T-G06 | gastar `30000` **sin** asignación | `has_budget = false` |
| T-G07 | asignar `100000`, gastar `100000` | `disponible = 0`, `has_budget = true`. *Distinto de T-G06* |
| T-G08 | asignar `100000`, marcar el `budget_entry` con `deleted_at`, gastar `30000` | `has_budget = false`, el asignado no cuenta |
| T-G09 | P1: asignar `100000`, gastar `30000`. P2: rollover `70000` + manual `100000` | `disponible` de P2 = `170000`, **sin consultar P1** |
| T-G10 | gasto con `booked_at` fuera del rango del periodo | no se cuenta en ese periodo |
| T-G11 | `Nu +100000`, sin asignaciones, un periodo abierto | `100000` |
| T-G12 | `Nu +100000`, `TDC −25000` | `75000` |
| T-G13 | `Nu +100000`, `PorCobrar +50000` | **`100000`**, no `150000` — F3 excluye `receivable` |
| **T-G14** | **Ejemplo canónico #1.** `Nu +1000000`; asignar `200000` a Comida; gastar `50000` en Comida; gastar `30000` en Salud sin presupuesto | **`740000`** ($7,400). `dinero_real = 920000`; `Comida = +150000`; `Salud = −30000`; `comprometido = 180000` |
| **T-G15** | **Contraprueba de la resta global.** Mismo estado que T-G14, calculando `dinero_real − (SUM(asignado) − SUM(gastado))` a mano en el test | el valor de control es **`800000`** ($8,000), y **`fn_unassigned_funds` NO debe devolverlo**. *Este test es el que impide "simplificar" la fórmula después* |
| **T-G16** | **Ejemplo canónico #2, dos periodos abiertos.** Estado de T-G14 + ingreso `+500000`; crear P2 **sin cerrar P1**; asignar `100000` a Comida en P2 | **`1140000`** ($11,400). `dinero_real = 1420000`; P1 aporta `180000`; P2 aporta `100000`. *Si devuelve `1320000`, la función agrega solo un periodo* |
| **T-G17** | **Periodos cerrados excluidos.** P1 con `Comida` sobrante `150000` y `rollover_type='accumulate'`; insertar el `budget_entry` de rollover `150000` en P2; **cerrar P1**; consultar | el compromiso de `150000` se cuenta **una sola vez** (vía P2). *Si se cuenta dos veces, la función incluye periodos cerrados (Fallo A)* |
| T-G18 | registrar ingreso `+500000` a `Nu` | el resultado sube exactamente `500000`, no `1000000` |
| T-G19 | tx con `booked_at` en un hueco entre periodos; otra dentro de un periodo | la primera aparece en F4, la segunda no |
| **T-G20** | **Archivar no mueve dinero (F1).** Capturar `fn_account_balances` completo; archivar una cuenta `expense` con saldo; recapturar | **los saldos son idénticos**; la cuenta archivada sigue apareciendo |
| **T-G21** | **Archivar no mueve dinero (F3).** Capturar `fn_unassigned_funds`; archivar la categoría "Comida" con gasto histórico y con `disponible` en el periodo abierto; recapturar | **el valor es idéntico**. *Si cambia, alguna función filtra `archived_at`* |
| T-G22 | invocar F1–F4 sin `p_user_id` | falla las cuatro |
| T-G23 | `SELECT * FROM fn_unassigned_funds(<uuid>, <uuid>)` | **falla** — la función no acepta segundo argumento. *Si pasa, quedó con la firma vieja* |

## Grupo H — Idempotencia (U05)

| ID | Entrada | Esperado |
|---|---|---|
| T-H01 | dos tx del mismo usuario con `idempotency_key` distinta | ✅ ambas |
| **T-H02** | **Mecanismo completo.** `INSERT ... ON CONFLICT (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING RETURNING id` con una key ya usada | devuelve **0 filas**; la transacción **no** queda abortada; un `SELECT ... WHERE user_id=$1 AND idempotency_key=$2` **en la misma transacción de DB** devuelve la tx original |
| **T-H03** | **El segundo intento no crea nada.** Contar `transactions` antes y después de T-H02 | conteo **idéntico**; el `id` devuelto por el `SELECT` es el de la primera tx |
| T-H04 | `INSERT` plano con key duplicada (sin `ON CONFLICT`) | ❌ `23505`; la tx queda abortada y un `SELECT` posterior falla con `25P02`. *Documenta por qué el catch-and-select no es viable* |
| T-H05 | misma key para A y para B | ✅ ambas |
| T-H06 | tres tx con `idempotency_key = NULL` | ✅ las tres (índice parcial) |

## Grupo I — `nextDueOn` ⭐ *unitarios, sin DB* (U08a, U08b)

| ID | Entrada | Esperado |
|---|---|---|
| T-I01 | `day=15`, confirmado `2026-01-15` | `2026-02-15` |
| T-I02 | `day=31`, confirmado `2026-01-31` (año no bisiesto) | **`2026-03-01`** |
| T-I03 | `day=31`, confirmado `2024-01-31` (año bisiesto) | **`2024-03-01`** |
| T-I04 | `day=30`, confirmado `2026-01-30` | **`2026-03-01`** |
| T-I05 | `day=31`, confirmado `2026-03-31` | **`2026-05-01`** (abril no tiene 31) |
| T-I06 | **Sin corrimiento acumulado.** `day=31`, confirmado `2026-01-31` → `2026-03-01`; luego confirmado `2026-03-01` | **`2026-03-31`**, no `2026-04-01` |
| T-I07 | `day_of_month` = `0` y = `32` | ❌ `23514` ambos |
| T-I08 | `amount_cents` = `0` y = `−100` | ❌ `23514` ambos |

## Grupo J — Soft delete y borrado de usuario

| ID | Entrada | Esperado |
|---|---|---|
| T-J01 | `DELETE FROM profiles WHERE id = A` con datos de A | ❌ `23503` |
| T-J02 | `UPDATE profiles SET deleted_at = now()` | ✅; los datos de A siguen íntegros y consultables |
| T-J03 | consultar `information_schema.columns` para `transactions` y `entries` | **no existe** `deleted_at` en ninguna |
| T-J04 | soft delete de un `budget_period` | excluido de la resolución de periodo, de F2 y de F3 |
| T-J05 | soft delete de un `budget_entry` | excluido de F2 y F3 |
| T-J06 | soft delete de un `recurring_template` | excluido de la lista de vencidos |

## Grupo K — Seeds (U21)

| ID | Entrada | Esperado |
|---|---|---|
| T-K01 | `fn_seed_new_user(<uuid nuevo>)` | 7 `expense` con sus `rollover_type` exactos, 1 `income` "Sueldo", 1 `equity` "Saldo Inicial" con `is_system=true` |
| T-K02 | mismo | **0** cuentas `asset`, `liability` o `receivable` |
| T-K03 | invocarla dos veces con el mismo `p_user_id` | no duplica, no lanza; el conteo sigue en 9 |

## Grupo L — Estructura y reproducibilidad

| ID | Entrada | Esperado |
|---|---|---|
| T-L01 | `pg_extension` | `pgcrypto` y `btree_gist` presentes |
| T-L02 | `pg_enum` para `account_type` | los seis valores, incluido `receivable` |
| T-L03 | `migrate reset --force` + `migrate deploy` sobre contenedor limpio | **9 triggers verificados por lista nominal** (nombre, tabla, timing, eventos, regla — ver `ARCHITECTURE.md` §3.4), **5 funciones**, **24 policies**, el `EXCLUDE`, **3 enums**, **2 extensiones**. Consultar `pg_trigger`, `pg_proc`, `pg_policies`, `pg_constraint`, `pg_type`, `pg_extension`. **No asumir: consultar los catálogos.** *Son 9 y no 11 porque R1, R2, R4 y el disparo de R9 sobre `entries` comparten una única función diferida. La verificación es nominal y no por conteo: un conteo agregado se rompe ante cualquier fusión o división legítima de triggers, sin que nada esté mal* |
| T-L04 | script de paridad: enumerar triggers, funciones, constraints, índices y policies | falla si el conjunto difiere del esperado. *Defensa contra objetos creados a mano (RD1)* |
| T-L05 | `pg_tables.rowsecurity` en las seis; conteo en `pg_policies` | `true` en las seis; 24 policies |
| T-L06 | `pg_views` para los nombres de esta capa | **0 resultados** — F1–F4 son funciones, no vistas |
| T-L07 | `pg_constraint.confdeltype` en las seis FKs a `profiles` | `'r'` (RESTRICT) en las seis |
| T-L08 | `pg_trigger` filtrando por la función de R9 | **dos** triggers: uno sobre `entries`, uno sobre `transactions` |

## Grupo M — `BigInt` (U23)

| ID | Entrada | Esperado |
|---|---|---|
| T-M01 | `amount_cents = 9007199254740993` (> 2^53) vía Prisma | se lee idéntico; falla si algo lo convierte a `number` |
| T-M02 ⭐ | `JSON.stringify({ n: 10n })` tras el bootstrap | string, sin `TypeError` |
| T-M03 ⭐ | `metadata` con un valor no serializable hacia `ErrorLog` | se persiste con placeholder legible, no lanza |
| T-M04 ⭐ | repartir `100` entre `3` | `[34, 33, 33]`; la suma es exactamente `100` |

## 5.3 Ciclo de cierre — tests de efecto

> **⚠️ Marcado para tu confirmación.** El algoritmo de cierre es un **Service**, explícitamente fuera del alcance de esta tarea (§3.10 y "Fuera de alcance"). Estos tests **no ejecutan el cierre**: insertan a mano los `budget_entries` que el cierre produciría y verifican que el schema y las funciones reaccionan correctamente. Es lo máximo verificable desde la capa de datos. Los tests del algoritmo en sí pertenecen al `TASK` de Services.

| ID | Entrada | Esperado |
|---|---|---|
| T-N01 | **`accumulate` con sobrante.** P1: Servicios (`accumulate`), asignar `200000`, gastar `50000` → `disponible = +150000`. Insertar rollover `+150000` en P2 con `source='rollover'`. Cerrar P1 | F2 de P2 muestra `asignado = 150000`; F3 cuenta el compromiso **una sola vez** |
| T-N02 | **`reset` con sobrante NO arrastra.** P1: Comida (`reset`), asignar `200000`, gastar `50000`. **No** insertar rollover. Cerrar P1 | F2 de P2 para Comida: `has_budget = false`. F3 **sube** `150000` respecto al estado con P1 abierto — el sobrante se liberó |
| T-N03 | **Sobregiro se arrastra en `accumulate`.** P1: Servicios, asignar `100000`, gastar `130000` → `disponible = −30000`. Insertar `budget_entry` de `−30000` en P2. Cerrar P1 | F2 de P2 muestra `asignado = −30000`; F3 lo cuenta como compromiso positivo de `30000` |
| T-N04 | **Sobregiro se arrastra también en `reset`.** P1: Comida (`reset`), asignar `100000`, gastar `130000`. Insertar `−30000` en P2. Cerrar P1 | igual que T-N03. *`reset` significa "el sobrante no se acumula", no "la deuda se perdona"* |
| T-N05 | **Doble materialización imposible.** Insertar dos veces el rollover para `(P2, Servicios)` | ❌ `23505` en el segundo |
| T-N06 | **Cierre desordenado — comportamiento a nivel de base de datos.** Cerrar P2; luego intentar insertar el rollover de P1 en P2 (lo que haría el cierre de P1) | ❌ **`P1011`** (R11). *A nivel de base este es el comportamiento correcto. La conversión a `ClosedPeriodException` con mensaje accionable es responsabilidad del Service (U24 / S-R2) y se testea allá* |

---

# 6. Mapeo `ERRCODE` → excepción → HTTP

Los `ERRCODE` se definen en esta tarea; las excepciones y el mapeo HTTP se implementan en la tarea de Services. **Esta tabla es normativa: los nombres no se inventan por archivo.**

| ERRCODE | Regla | Qué se violó | Excepción NestJS | HTTP |
|---|---|---|---|---|
| `P1001` | R1 | Los entries de la transacción no suman cero | `UnbalancedTransactionException` | `422` |
| `P1002` | R2 | La transacción tiene exactamente un entry | `UnbalancedTransactionException` | `422` |
| `P1003` | R3 | El `user_id` del entry no coincide con su transacción o su cuenta | `OwnershipMismatchException` | `403` |
| `P1004` | R4 | La transacción mezcla cuentas de distinta moneda | `MixedCurrencyException` | `422` |
| `P1005` | R5 | Intento de `UPDATE`/`DELETE` sobre `entries` | `ImmutableLedgerException` | `409` |
| `P1006` | R6 | Intento de `DELETE` o de `UPDATE` de campo contable en `transactions` | `ImmutableLedgerException` | `409` |
| `P1007` | R7 | El `category_id` no apunta a una cuenta `expense` del mismo usuario | `InvalidBudgetCategoryException` | `422` |
| `P1008` | R8 | Intento de archivar una cuenta `asset`/`receivable`/`liability` con saldo ≠ 0 | `AccountNotEmptyException` | `409` |
| `P1009` | R9 | La magnitud de la reversa no coincide con la del original (o la reversa está vacía) | `InvalidReversalException` | `422` |
| `P1010` | R10 | Intento de editar fechas de un periodo cerrado | `ClosedPeriodException` | `409` |
| `P1011` | R11 | Intento de editar o borrar un `budget_entry` de un periodo cerrado | `ClosedPeriodException` | `409` |

**Códigos estándar de Postgres que también hay que mapear:**

| ERRCODE | Origen | Excepción NestJS | HTTP |
|---|---|---|---|
| `23P01` | `EXCLUDE` de `budget_periods` | `PeriodOverlapException` | `409` |
| `23505` sobre `transactions_idempotency_uniq` | índice de idempotencia | **caso especial** — no es error: se recupera la transacción existente y se responde `200` | `200` |
| `23505` sobre `transactions_reverses_uniq` | doble reversa | `InvalidReversalException` | `409` |
| `23505` sobre `accounts_user_name_active_uniq` | nombre de cuenta duplicado | `DuplicateAccountNameException` | `409` |
| `23505` sobre `budget_entries_rollover_uniq` | doble materialización de rollover | `DuplicateRolloverException` | `409` |
| `23503` | FK en `RESTRICT` | `ResourceInUseException` | `409` |
| `23514` | cualquier `CHECK` | `InvalidInputException` | `422` |
| `25P02` | transacción abortada | `InternalServerErrorException` | `500` — **nunca debería llegar**; su aparición indica que se usó `INSERT` plano en vez de `ON CONFLICT DO NOTHING` |

**Regla de implementación:** el mapeo se hace **por `ERRCODE`**, nunca parseando el texto del mensaje. Para los `23505`, se discrimina por el **nombre del constraint** que Postgres devuelve en el campo `constraint` del error, no por el texto.

---

# 7. Qué NO debe hacer el agente

Prohibiciones duras. Violar cualquiera invalida la tarea aunque los tests estén en verde.

### 7.1 No resolver ningún PENDIENTE de §3.14 por criterio propio

Los pendientes, por nombre, para que sean identificables al toparse con ellos:

| # | PENDIENTE | Dónde aparece |
|---|---|---|
| P-01 | **Cierre sin periodo siguiente** — si se bloquea, se crea el periodo, o el rollover queda diferido | §3.10, U24/S-R2 |
| P-02 | **Algoritmo de reapertura de un periodo cerrado** — cómo se revierte y re-materializa el rollover en cadena | §3.10, T-E11 |
| P-03 | **Categoría "Pérdidas"** — si se siembra, se crea al primer uso, o la crea el usuario | §3.2, U21 |
| P-04 | **Ventana de visibilidad en la carrera de idempotencia** — reintento corto de lectura vs responder `409` | §3.5, T-H02 |
| P-05 | **`profiles.timezone`** — en qué tarea se agrega la columna y con qué default | §3.6, D4 |
| P-06 | **`profiles.deleted_at`** — en qué tarea se agrega la columna | §3.3, D4, T-J01/T-J02 |
| P-07 | ~~**Garantía de creación de `profiles` + punto de invocación de los seeds**~~ **RESUELTO** — `EnsureProfileExistsService.ensure()`, misma transacción, solo en la rama de inserción (`xmax = 0`) | §3.12, D3, U21 |
| P-08 | **Multi-moneda** — diferido, no implementar | §3.14 |
| P-09 | **Tools del MCP** — diferido | §3.14 |
| P-10 | **Tests de Service** — dependen de que existan los services | §3.14 |
| P-11 | **Cache** — diferido | §3.14 |

### 7.2 Prohibiciones de infraestructura

- **No usar `prisma db push`.** Ni "solo para probar rápido". No transporta triggers, funciones ni constraints escritos a mano (RD1).
- **No crear objetos desde la UI de Supabase.** Prototipar ahí es aceptable; dejarlo ahí no. Todo objeto debe existir en una migración versionada antes de considerarse hecho.
- **No ejecutar `prisma migrate dev`, en ningún entorno — ni siquiera con `--create-only`.** No es solo "nunca contra Supabase": tampoco funciona contra el Postgres local desde la segunda migración del proyecto en adelante. Usa una shadow database sin `auth.users` y falla — probado empíricamente, ver `TASK-auth.md` → "`shadowDatabaseUrl`: probado y descartado". Las migraciones se escriben a mano (§3) y se aplican con `migrate deploy`, siempre.
- **No editar migraciones ya aplicadas.** Se crea una migración nueva.
- **No declarar `multiSchema` ni ningún modelo de Prisma para `auth.users`.** Probado y descartado (§3, `TASK-auth.md`): hace que `migrate reset` borre `auth.users` en cada corrida, rompiendo `/verify`.

### 7.3 Prohibiciones de diseño

- **No modificar `ARCHITECTURE.md`.** Es entrada, no salida.
- **No "simplificar" la fórmula de F3** a `SUM(asignado) − SUM(gastado)`, ni colapsar periodos al agregar por categoría, ni acotarla a un solo periodo. Ver U18 y T-G14/T-G15/T-G16/T-G17.
- **No agregar `deleted_at` a `transactions` ni a `entries`** "por consistencia". Rompe la validación de suma-cero (§3.3).
- **No convertir F1–F4 en vistas.** El parámetro `p_user_id` obligatorio es una garantía estructural, no un detalle de estilo.
- **No abrirle excepciones a R5 ni a R11.**
- **No agregar `ON DELETE CASCADE` a ninguna FK hacia `profiles`.**
- **No filtrar `archived_at` dentro de ninguna función de consulta.**
- **No introducir ninguna columna de saldo** (`balance`, `total`, `available`) en ninguna tabla.
- **No usar `numeric`, `decimal`, `float`, `real` ni `double precision`** para montos.

### 7.4 Prohibiciones sobre los tests

- **No modificar, borrar, saltar (`it.skip`, `it.todo`) ni comentar un test para cerrar una unidad.**
- **No escribir tests de rechazo con `expect(...).toThrow()` genérico.** Se verifica el `ERRCODE` exacto y el estado intacto (§5).
- **No probar triggers diferidos esperando el error en el `INSERT`** (§5.1).

### 7.5 Qué hacer al toparse con una decisión no documentada

**Detenerse y preguntar. No elegir.**

Procedimiento exacto:

1. **No implementar nada** de la parte ambigua.
2. Dejar la unidad en curso **sin cerrar** (los tests que dependan de la decisión quedan en rojo, no se borran ni se saltan).
3. Emitir un bloque con este formato y **terminar el turno**:

```
🛑 DECISIÓN REQUERIDA

Unidad: U__
Punto: <qué hay que decidir, en una frase>
Referencia: ARCHITECTURE.md §___ / TASK-db.md §___
Bloquea: <qué tests o unidades quedan detenidos>
Opciones que veo: (a) ... (b) ...
Recomendación: <cuál y por qué — pero NO la apliques>
```

4. **No continuar con otras unidades** si la decisión afecta el orden del grafo (§3). Si es una hoja del grafo, se puede seguir con unidades independientes mientras tanto, dejando registro de la pausa.

**Señales de que estás ante una decisión, no ante una implementación:**
- El documento dice "PENDIENTE", "falta decidir" o "requiere decisión explícita".
- Dos secciones del `ARCHITECTURE.md` parecen contradecirse.
- Un test parece estar mal escrito o pedir algo imposible.
- Falta un dato de infraestructura (una variable de entorno, una columna de otra tarea).
- La implementación "obvia" requiere agregar una columna, tabla o constraint que no está en §3.3.

---

# 8. Dependencias con TASK-auth

### 8.1 Bloqueantes para esta tarea

**D1 — `profiles` debe existir.** Las seis tablas tienen FK a `profiles.id`. Ninguna migración `02x` puede aplicarse antes.

**D2 — Postgres local vía Docker.** Entregable de `TASK-auth`. Esta tarea lo reutiliza (U00), no levanta contenedor propio. Requisito adicional: versión 15+ con `btree_gist` disponible.

**D3 — Garantía de creación de `profiles` + punto de invocación de los seeds** (P-07). Si un usuario puede quedar autenticado sin fila en `profiles`, toda escritura falla con `23503`.

**D4 — Columnas nuevas en `profiles`:**

| Columna | Bloquea | ¿Requerida antes de las migraciones? |
|---|---|---|
| `deleted_at` (`timestamptz`) | **T-J01, T-J02** | **No para aplicar migraciones**, sí para cerrar U-tests del grupo J |
| `timezone` (string IANA) | Nada de esta capa | **No.** La usa el Service para calcular "hoy" (§3.6). No aparece en ninguna migración ni test de esta tarea |

**Precisión importante:** solo la **existencia de `profiles`** bloquea las migraciones. `deleted_at` bloquea dos tests; `timezone` no bloquea nada de esta tarea. No detenerse por `timezone`.

### 8.2 Qué hacer si `profiles` no existe

**El agente se detiene. NO crea una migración provisional.**

Razones, para que no se relajen:

1. Una `profiles` provisional creada aquí colisiona con la de `TASK-auth` cuando esa migración se aplique: dos migraciones intentando crear la misma tabla, y el historial queda irreconciliable sin un `reset`.
2. La forma exacta de `profiles` (columnas, relación 1:1 con `auth.users`, mecanismo de creación automática) es una decisión de `TASK-auth`. Adivinarla es resolver un PENDIENTE por criterio propio (P-07), prohibido por §7.1.
3. `migrate reset` reproduce el historial completo; una tabla provisional se convertiría en deuda permanente en ese historial.

**Procedimiento:** emitir el bloque `🛑 DECISIÓN REQUERIDA` de §7.5 indicando que falta `profiles` y qué migraciones quedan bloqueadas, y terminar el turno.

**Excepción — lo que sí se puede avanzar mientras tanto:** U00 (infra de tests), U01 (extensiones), U02 (enums), U08b (función pura) y U23 (helpers de `BigInt`) **no dependen de `profiles`** y pueden completarse.

### 8.3 Qué necesita `TASK-auth` de esta tarea

Nada bloqueante.

**Corrección a aplicar allá:** los tests 9 y 10 de `TASK-auth` (RLS con anon key) quedan **fuera de alcance** por la misma decisión que eliminó los tests de RLS de esta tarea (§3.15, C1 resuelto). Conviene quitarlos para que no queden como criterio inalcanzable.

### 8.4 Trabajo compartido

- **S1** — Los `ERRCODE` se definen aquí (§6); el mapeo a excepciones y HTTP se implementa en Services.
- **S2** — Override de `BigInt.prototype.toJSON` + serializador defensivo de `ErrorLog`: el bootstrap pertenece a `TASK-auth`; §4 ya lo documenta. Esta tarea depende de él para T-M02 y T-M03.
- **S3** — Policies RLS: `TASK-auth` define las de `profiles` y `ErrorLog`; esta tarea las de las seis tablas de datos. Patrón idéntico. Ninguna se testea.
- **S4** — Las cuatro reglas de U24 se transfieren al `TASK` de Services.

---

# 9. Estructura de archivos esperada

**No inventar estructura.** Si algo no cabe en este árbol, es señal de §7.5 (decisión requerida).

```
proyecto/
├── prisma/
│   ├── schema.prisma                    ← modelos, enums, índices declarativos
│   └── migrations/
│       ├── <ts>_00_extensions/migration.sql
│       ├── <ts>_01_enums/migration.sql
│       ├── <ts>_02a_accounts/migration.sql
│       ├── <ts>_02b_budget_periods/migration.sql
│       ├── <ts>_02c_transactions/migration.sql
│       ├── <ts>_02d_entries/migration.sql
│       ├── <ts>_02e_budget_entries/migration.sql
│       ├── <ts>_02f_recurring_templates/migration.sql
│       ├── <ts>_03_period_exclusion/migration.sql
│       ├── <ts>_04a_entries_deferred_checks/migration.sql     ← R1+R2+R4
│       ├── <ts>_04b_entries_owner_consistency/migration.sql   ← R3
│       ├── <ts>_04c_ledger_immutability/migration.sql         ← R5+R6
│       ├── <ts>_04d_reversal_magnitude/migration.sql          ← R9 (2 triggers)
│       ├── <ts>_04e_budget_entry_category/migration.sql       ← R7
│       ├── <ts>_04f_archive_zero_balance/migration.sql        ← R8
│       ├── <ts>_04g_closed_period_locks/migration.sql         ← R10+R11
│       ├── <ts>_05a_fn_account_balances/migration.sql
│       ├── <ts>_05b_fn_category_balances/migration.sql
│       ├── <ts>_05c_fn_unassigned_funds/migration.sql
│       ├── <ts>_05d_fn_transactions_without_period/migration.sql
│       ├── <ts>_06_rls/migration.sql
│       └── <ts>_07_seed_function/migration.sql
│
├── src/
│   ├── main.ts                          ← bootstrap; override de BigInt en la PRIMERA línea
│   ├── modules/
│   │   └── ledger/
│   │       ├── repositories/            ← consumidores de F1–F4 vía $queryRaw
│   │       │   ├── account-balances.repository.ts
│   │       │   ├── category-balances.repository.ts
│   │       │   ├── unassigned-funds.repository.ts
│   │       │   └── transactions-without-period.repository.ts
│   │       └── types/                   ← tipos manuales del retorno de F1–F4 (Prisma no las tipa)
│   │           └── query-functions.types.ts
│   └── shared/
│       ├── money/
│       │   ├── split.ts                 ← helper de reparto de residuo (U23)
│       │   └── bigint-serializer.ts     ← override + serializador defensivo (U23)
│       └── recurrence/
│           └── next-due-on.ts           ← función pura (U08b)
│
├── test/
│   ├── setup/
│   │   ├── db.ts                        ← conexión, BEGIN/ROLLBACK por test
│   │   ├── expect-errcode.ts            ← aserción de ERRCODE + estado intacto
│   │   ├── commit-helper.ts             ← ⚠️ transacción que SÍ llega al COMMIT (§5.1)
│   │   └── fixture.ts                   ← U22: usuarios A y B con sus cuentas y periodos
│   ├── integration/
│   │   ├── a-balance-zero.spec.ts       ← Grupo A
│   │   ├── b-ownership.spec.ts          ← Grupo B
│   │   ├── c-immutability-reversal.spec.ts  ← Grupo C
│   │   ├── d-accounts.spec.ts           ← Grupo D
│   │   ├── e-periods.spec.ts            ← Grupo E
│   │   ├── f-budget.spec.ts             ← Grupo F
│   │   ├── g-query-functions.spec.ts    ← Grupo G
│   │   ├── h-idempotency.spec.ts        ← Grupo H
│   │   ├── j-soft-delete.spec.ts        ← Grupo J
│   │   ├── k-seeds.spec.ts              ← Grupo K
│   │   ├── l-structure.spec.ts          ← Grupo L
│   │   └── n-close-cycle.spec.ts        ← Grupo N (§5.3)
│   └── unit/
│       ├── next-due-on.spec.ts          ← Grupo I (T-I01–T-I06)
│       └── money.spec.ts                ← Grupo M (T-M02–T-M04)
│
├── scripts/
│   └── db-parity-check.ts               ← T-L04
│
├── docker-compose.yml                   ← Postgres 15+ de tests (de TASK-auth)
├── .env                                 ← DATABASE_URL
└── .env.test                            ← TEST_DATABASE_URL
```

**Reglas de ubicación:**

- **Todo el SQL de triggers, funciones, policies, `EXCLUDE` e índices parciales vive dentro del `migration.sql`** de su migración. No hay carpeta `sql/` suelta: un archivo fuera del historial de migraciones es exactamente lo que RD1 prohíbe.
- **Un archivo de test por grupo**, con el prefijo de letra del grupo. Los IDs de test (`T-A03`) van en el nombre del `it(...)` para que el fallo sea rastreable a este documento.
- **Los tests unitarios no importan nada de `test/setup/db.ts`.** Si lo necesitan, no son unitarios.
- **`scripts/db-parity-check.ts` se ejecuta también contra Supabase** (acción humana #18), no solo contra el contenedor.

---

# 10. Acciones humanas requeridas

Lista para seguir paso a paso. Cada paso trae **cómo verificar que quedó bien antes de pasar al siguiente**. Los pasos 1–12 van **antes** de que el loop arranque.

## Fase 1 — Supabase

### 1. Confirmar el proyecto de Supabase
Dashboard → tu proyecto. Anotar el **Project Ref** (la cadena en la URL, `https://supabase.com/dashboard/project/<PROJECT_REF>`).
**Verificar:** el proyecto está en estado `Active Healthy`, no `Paused`.

### 2. Verificar la versión de Postgres
Dashboard → Settings → Infrastructure → *Postgres version*.
**Requerido: 15 o superior.** Si está en 14, actualizar antes de continuar (Settings → Infrastructure → Upgrade).
**Verificar:** anota la versión exacta (ej. `15.6`). **La vas a necesitar en el paso 8** — el contenedor de tests debe usar la misma versión mayor.

### 3. Habilitar extensiones
Dashboard → Database → Extensions. Buscar y habilitar:
- `pgcrypto`
- `btree_gist`

Aunque las migraciones traen `CREATE EXTENSION IF NOT EXISTS`, en Supabase algunas requieren habilitación previa por permisos del rol.
**Verificar** en Dashboard → SQL Editor:
```sql
SELECT extname FROM pg_extension WHERE extname IN ('pgcrypto','btree_gist');
```
Deben salir **las dos filas**. Si falta alguna, el paso 3 no está hecho y `03_period_exclusion` va a fallar.

### 4. Obtener el connection string
Dashboard → Settings → Database → *Connection string* → pestaña **URI**.
Elegir **Direct connection** (puerto **5432**), **no** el Transaction/Session pooler (6543).
Sustituir `[YOUR-PASSWORD]` por la contraseña de la base (Settings → Database → *Database password*; si no la tienes, *Reset database password*).
**Verificar:**
```bash
psql "<connection string>" -c "SELECT current_database(), version();"
```
Debe conectar e imprimir la versión que anotaste en el paso 2.

### 5. Confirmar que `profiles` existe
En SQL Editor:
```sql
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema='public' AND table_name='profiles'
ORDER BY ordinal_position;
```
**Si la tabla no existe, DETENTE.** `TASK-auth` va primero (§8.2).
**Verificar además:** que exista `deleted_at`. Si no está, los tests T-J01 y T-J02 quedarán bloqueados (P-06) — no impide arrancar, pero anótalo.

### 6. Verificar el schema destino
Todas las tablas van en `public`. Si tu connection string trae `?schema=`, confirma que dice `public`.

## Fase 2 — Variables de entorno

### 7. Crear `.env` y `.env.test`

**`.env`** (Supabase, para migraciones y runtime):

| Variable | Valor | De dónde sale |
|---|---|---|
| `DATABASE_URL` | `postgresql://postgres:<PASSWORD>@db.<PROJECT_REF>.supabase.co:5432/postgres` | Paso 4 |
| `DIRECT_URL` | **el mismo valor que `DATABASE_URL`** | Hoy no se usa pooler. Existe para que activar el pooler después no requiera tocar `schema.prisma` |

**`.env.test`** (Postgres local de Docker):

| Variable | Valor | De dónde sale |
|---|---|---|
| `TEST_DATABASE_URL` | `postgresql://postgres:postgres@localhost:5433/budget_test` | Paso 8. **Puerto 5433**, no 5432, para no chocar con un Postgres local que ya tengas |

**Verificar:** ambos archivos están en `.gitignore`. `git status` no debe listarlos.

## Fase 3 — Contenedor de tests

### 8. Levantar Postgres local

`docker-compose.yml` (o el de `TASK-auth`, extendido). **La imagen debe coincidir en versión mayor con Supabase** (paso 2):

```yaml
services:
  db-test:
    image: postgres:15          # ← misma mayor que Supabase
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: budget_test
    ports:
      - "5433:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      retries: 10
```

```bash
docker compose up -d db-test
docker compose ps          # db-test debe decir "healthy"
```

**Verificar la versión:**
```bash
psql "$TEST_DATABASE_URL" -c "SHOW server_version;"
```
La mayor debe coincidir con la del paso 2. Si Supabase está en 15 y el contenedor en 16, hay riesgo de que algo pase en local y falle en producción.

### 9. Instalar las extensiones en el contenedor

```bash
psql "$TEST_DATABASE_URL" -c "CREATE EXTENSION IF NOT EXISTS pgcrypto;"
psql "$TEST_DATABASE_URL" -c "CREATE EXTENSION IF NOT EXISTS btree_gist;"
```

**Si el segundo falla**, la imagen no trae `btree_gist` y **no sirve**. La oficial `postgres:15` sí lo trae; una `alpine` mínima puede no traerlo. Cambia la imagen antes de continuar.

**Verificar:**
```bash
psql "$TEST_DATABASE_URL" -c "SELECT extname FROM pg_extension WHERE extname IN ('pgcrypto','btree_gist');"
```
Dos filas.

### 10. Verificar que `profiles` existe también en el contenedor

Las migraciones de `TASK-auth` deben poder aplicarse ahí:

```bash
DATABASE_URL="$TEST_DATABASE_URL" npx prisma migrate deploy
psql "$TEST_DATABASE_URL" -c "\d profiles"
```

Si `profiles` no aparece, el loop no puede correr ningún test de integración de esta capa.

## Fase 4 — Scripts de npm

### 11. Definir los scripts

En `package.json`:

```json
{
  "scripts": {
    "test:unit": "jest --testPathPattern=test/unit",
    "test:integration": "dotenv -e .env.test -- jest --testPathPattern=test/integration --runInBand",
    "db:reset:test": "dotenv -e .env.test -- prisma migrate reset --force --skip-seed",
    "db:parity": "tsx scripts/db-parity-check.ts"
  }
}
```

**`--runInBand` no es opcional:** los tests de integración comparten una sola base; en paralelo se pisan entre sí y producen fallos intermitentes que el loop interpretará como bugs de implementación.

**Verificar:** `npm run test:unit` corre (aunque no haya tests todavía) sin error de configuración.

### 12. Confirmar que el loop tiene todo

Checklist antes de arrancar el agente:

- [ ] Supabase activo, Postgres 15+, `pgcrypto` y `btree_gist` habilitadas
- [ ] `.env` y `.env.test` creados y en `.gitignore`
- [ ] Contenedor `db-test` healthy, misma versión mayor, con las dos extensiones
- [ ] `profiles` existe en Supabase **y** en el contenedor
- [ ] Scripts de npm definidos, `test:integration` con `--runInBand`
- [ ] `ARCHITECTURE.md` y `TASK-db.md` accesibles para el agente

## Fase 5 — Durante la implementación

### 13. Revisar cada `.sql` generado con `--create-only`
Es el único momento en que entran triggers, funciones y constraints. Si se aplica sin editar, la migración queda incompleta y no es corregible sin `reset`.

### 14. Revisar personalmente U18 (F3) antes de darla por cerrada
Es la unidad con más superficie de error silencioso. Leer la implementación y confirmar las tres cosas: **firma de un solo parámetro**, **agregación por par `(categoría, periodo abierto)`**, y **exclusión de periodos cerrados**.

### 15. Vigilar que no aparezcan `it.skip` ni tests borrados
```bash
grep -rn "it.skip\|it.todo\|xit(\|describe.skip" test/
```
Debe devolver vacío.

## Fase 6 — Despliegue

### 16. Aplicar migraciones a Supabase

```bash
npx prisma migrate deploy
```

**Nunca `migrate dev` contra producción.**
**Verificar:**
```bash
npx prisma migrate status
```
Debe decir que el schema está al día, sin migraciones pendientes.

### 17. Verificar RLS manualmente

```sql
SELECT tablename, rowsecurity FROM pg_tables
WHERE schemaname='public'
  AND tablename IN ('accounts','transactions','entries',
                    'budget_periods','budget_entries','recurring_templates');

SELECT tablename, count(*) FROM pg_policies
WHERE schemaname='public'
  AND tablename IN ('accounts','transactions','entries',
                    'budget_periods','budget_entries','recurring_templates')
GROUP BY tablename;
```

Las seis con `rowsecurity = true` y **4 policies cada una**.
**Este paso es manual y crítico precisamente porque RLS no está cubierta por tests** (§7 del ARCHITECTURE). Es la única verificación que existe.

### 18. Correr el script de paridad contra Supabase

```bash
DATABASE_URL="<supabase>" npm run db:parity
```

Verifica que producción y la base de tests derivan del mismo historial. **Si difiere, hay un objeto creado a mano** — encuéntralo y muévelo a una migración.

### 19. Verificar los seeds con un usuario real

Crear una cuenta desde el flujo de signup real y confirmar:

```sql
SELECT name, type, rollover_type, is_system
FROM accounts WHERE user_id = '<uuid del usuario nuevo>' ORDER BY type, name;
```

Esperado: 7 `expense` con sus `rollover_type`, 1 `income` "Sueldo", 1 `equity` "Saldo Inicial" con `is_system=true`, y **cero** cuentas `asset`/`liability`/`receivable`.

Depende del mecanismo de creación de `profiles` (P-07), la pieza más frágil de la integración entre tareas.

---

# 11. Fuera de alcance (no implementar)

- Cualquier `Service`, `Controller`, `Repository` con lógica de negocio, DTO o endpoint — salvo la función pura de U08b, los helpers de U23 y los repositories de lectura que consumen F1–F4.
- **Tests de RLS** y cualquier infraestructura para emular el contexto de Supabase en Docker.
- El **algoritmo** de cierre de periodo y materialización de rollover — es un Service. Esta tarea garantiza que el schema lo soporte (§5.3) y que la doble materialización sea imposible (T-F07, T-N05).
- Tools del MCP.
- Onboarding y trabajo de front.
- Multi-moneda (`exchange_rate`, `amount_base_cents`).
- Columnas de `profiles` — pertenecen a `TASK-auth` (D4).
- Cualquier PENDIENTE de §7.1 (P-01 … P-11).
