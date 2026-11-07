# ARCHITECTURE.md

## Resumen

Backend NestJS con arquitectura en capas y patrón Repository (Ports & Adapters), desplegado serverless en Vercel, usando Supabase como Postgres managed (con RLS activo como defensa en profundidad) + proveedor de Auth — con autorización de negocio centralizada en código (no en RLS), diseñado para que cualquier proveedor externo (DB, Auth, cache, logging) se pueda sustituir sin tocar la lógica de negocio. Frontend en Next.js (App Router) con Atomic Design, consumiendo la API vía un cliente centralizado.

---

## 1. Arquitectura del backend

### Capas

```
┌─────────────────────────────────────┐
│   Controllers (HTTP layer)           │  ← recibe requests, responde HTTP
├─────────────────────────────────────┤
│   DTOs + class-validator             │  ← valida forma del dato (ValidationPipe global)
├─────────────────────────────────────┤
│   Services (lógica de negocio)       │  ← reglas, excepciones custom, autorización
├─────────────────────────────────────┤
│   Interfaces (contratos / "ports")   │  ← IAuthRepository, IOrderRepository, etc.
├─────────────────────────────────────┤
│   Repositories (implementación /     │  ← PrismaOrderRepository, SupabaseAuthRepository
│   "adapters")                        │
├─────────────────────────────────────┤
│   Infraestructura externa            │  ← Supabase (Postgres + Auth)
└─────────────────────────────────────┘
```

**Regla de dependencia:** cada capa solo conoce la inmediatamente inferior, y únicamente a través de interfaces. Un `Service` nunca importa Prisma ni el SDK de Supabase directamente; solo conoce `IOrderRepository` / `IAuthRepository`.

**Nombre técnico:** Layered Architecture con Ports & Adapters (Hexagonal ligero, aplicado de forma pragmática sin el ceremonial completo de Clean Architecture).

### Piezas transversales (cross-cutting)

- `AuthGuard` — protege rutas, valida JWT vía `IAuthRepository`.
- `GlobalExceptionFilter` — captura errores de cualquier capa, decide la respuesta al cliente, escribe en `ErrorLog`.
- `ValidationPipe` global (`whitelist`, `forbidNonWhitelisted`, `transform`) — valida DTOs antes del Controller.
- Logging (Nest `Logger` + interceptor de requests) — observa sin meterse en la lógica de negocio.

### Principios SOLID aplicados

| Principio | Cómo se manifiesta en este proyecto |
|---|---|
| **S — Single Responsibility** | Controller solo maneja HTTP; Service solo lógica de negocio; Repository solo acceso a datos/Auth; cada clase tiene una sola razón para cambiar. |
| **O — Open/Closed** | Nuevas implementaciones (ej. `Auth0AuthRepository`) se agregan sin modificar `AuthGuard`, services ni controllers existentes — solo se añade una clase nueva que cumple la interfaz. |
| **L — Liskov Substitution** | Cualquier implementación de `IAuthRepository`/`IOrderRepository` debe ser intercambiable sin romper el código que la consume. Las interfaces no exponen detalles específicos del proveedor (ej. `validateToken` regresa `{ userId, email }` genérico, no la forma cruda del JWT de Supabase). |
| **I — Interface Segregation** | Interfaces separadas por responsabilidad puntual en vez de una interfaz gigante; si `signUp`/`resetPassword` no las usa el 90% del código, se evalúan como interfaces separadas de `validateToken`/`signIn`. |
| **D — Dependency Inversion** | Services dependen de interfaces (`IAuthRepository`, `IOrderRepository`), nunca de clases concretas. NestJS resuelve la inyección vía provider tokens (`{ provide: 'IAuthRepository', useClass: SupabaseAuthRepository }`). Es la base que permite cambiar Prisma, Supabase o el proveedor de auth sin tocar la lógica de negocio. |

---

## 2. Auth

### Flujo

1. Frontend (Next.js App Router + `@supabase/ssr`) ejecuta login/signup directo contra Supabase Auth.
2. Sesión persiste en cookies httpOnly (nunca `localStorage`). `@supabase/ssr` refresca el access token automáticamente mientras el refresh token siga vigente.
3. Frontend envía el JWT en cada request a la API NestJS: header `Authorization: Bearer <token>`.
4. `AuthGuard` intercepta el request y delega la validación a `IAuthRepository.validateToken(token)`.
5. `SupabaseAuthRepository.validateToken()` valida el JWT localmente con las llaves públicas del proyecto (JWKS de Supabase), cacheadas localmente (sin round-trip a la API de Supabase por request).
6. Si válido, extrae `userId` (claim `sub`) y `email`, los adjunta al contexto del request.
7. Controller/Service ejecutan la acción. El `userId` usado en cualquier query u operación **siempre** proviene del JWT decodificado, nunca de un parámetro enviado por el cliente (body/query).
8. Token inválido/expirado → 401. Sin permiso de negocio para la acción → 403 (autorización en código, no en RLS).

### Responsabilidades por capa

| Capa | Responsabilidad |
|---|---|
| Frontend (Next.js + `@supabase/ssr`) | Login/signup, sesión en cookies httpOnly, refresh automático, envío del JWT en `Authorization` |
| Supabase Auth | Ciclo completo de autenticación (signup, login, password reset, emisión de JWT + refresh token) |
| `AuthGuard` (NestJS) | Único punto de entrada para proteger rutas; siempre delega a `IAuthRepository`, nunca valida directo |
| `IAuthRepository` (port) | Contrato genérico (`validateToken`, `signIn`, `signUp`) desacoplado del proveedor |
| `SupabaseAuthRepository` (adapter) | Única capa que conoce detalles de Supabase Auth; valida JWT contra las llaves públicas del JWKS |
| Repositories de datos (Prisma) | Ejecutan queries con `userId` ya validado; no re-validan auth; corren con permisos de servicio (rol que bypassa RLS) |
| RLS (Postgres/Supabase) | Activo como defensa en profundidad adicional — protege ante acceso directo a la DB fuera del backend (ver sección 3) |
| `GlobalExceptionFilter` | Traduce cualquier excepción (incluyendo fallas de auth) a respuesta HTTP consistente; nunca expone stack trace |
| `ErrorLog` (tabla) | Persiste errores de auth de forma best-effort, sin bloquear la respuesta al cliente |

### Roles y permisos

Fase actual: **un solo tipo de usuario, sin modelo de roles.** No se implementa columna `role` ni lógica de permisos diferenciados por rol. Si se requiere en el futuro, se evaluará entonces dónde vive (Prisma `profiles` vs. `user_metadata` de Supabase) — no forma parte del alcance actual.

### Manejo de sesión expirada a media operación

Supabase refresca el access token automáticamente mientras el refresh token siga vigente (frontend, vía `@supabase/ssr`) — cubre la mayoría de los casos (ej. formularios largos). Cuando el refresh falla (revocación, expiración de refresh token, error de red), el backend responde 401 normal; el frontend debe:
- Mantener el estado del formulario fuera del ciclo de sesión (ej. estado local/`localStorage` del formulario, no del JWT).
- Detectar 401 específicamente y solicitar re-login sin perder los datos capturados.
- Rehidratar el formulario tras el re-login.

---

## 3. Base de datos

- **Proveedor:** Supabase (Postgres managed).
- **ORM:** Prisma, actuando con permisos de servicio (bypassa RLS). Conexión directa (puerto 5432); sin connection pooler (pgbouncer) por ahora — se activa cuando el volumen de tráfico lo justifique, es cambio de connection string, no de código.
- **RLS:** **activo** como capa de defensa en profundidad, aunque Prisma no la "vea" (usa conexión de servicio). Protege ante cualquier acceso futuro que no pase por el backend (ej. si algún día se habilita acceso directo desde cliente, Supabase Realtime, o fuga del anon key). Las policies deben reflejar las mismas reglas de autorización que ya existen en código — es respaldo, no la fuente de verdad de autorización.
- **Autorización de negocio:** vive en Services/Repositories (código), no en RLS. RLS es cinturón de seguridad adicional.
- **Migraciones:** Prisma Migrate.
- **Cache:** no implementado. El patrón Repository ya aísla el acceso a datos, de forma que agregar cache (ej. Redis, patrón cache-aside) en el futuro no requiere tocar Services ni Controllers — solo el Repository correspondiente.

---

## 3.1 Capa de datos — modelo de dominio

### Resumen del enfoque

El dominio es una aplicación de **presupuesto personal por sobres (envelope budgeting)** con soporte para cuentas reales (efectivo, débito, tarjeta de crédito), préstamos entre personas, y análisis histórico de gasto.

La capa de datos se apoya en tres decisiones estructurales. Todo lo demás se deriva de ellas:

**1. Contabilidad de partida doble (double-entry).**
Una transacción no tiene "cuenta origen", "cuenta destino" ni "categoría" como columnas. Tiene N *entries*, cada uno con una cuenta y un monto con signo, y la suma de los entries de una transacción **siempre es cero**. Un gasto, una transferencia, un pago de tarjeta, un préstamo y una cuenta dividida son el mismo caso mecánico; no existen tipos especiales de transacción.

**2. Dos ledgers separados que no se mezclan.**

| Ledger | Tablas | Responde a | Regla |
|---|---|---|---|
| **Dinero** | `transactions` + `entries` | ¿Dónde está mi dinero? | Nunca rechaza una transacción. No conoce periodos, ni cierres, ni presupuestos. |
| **Presupuesto** | `budget_periods` + `budget_entries` | ¿A qué está destinado mi dinero? | Puede quedar en estado pendiente de resolver sin bloquear el ledger de dinero. |

Esta separación es la que permite capturar un gasto atrasado sin corromper el histórico: el saldo de la cuenta se corrige siempre, y la asignación presupuestal se resuelve aparte.

**3. Las categorías de gasto SON cuentas.**
No existe una tabla `categories`. Una categoría es una fila en `accounts` con `type = 'expense'`. Esto elimina la duplicación entre "cuenta de gasto" y "categoría de presupuesto", y permite que un entry apunte a una categoría con el mismo mecanismo con el que apunta a una cuenta bancaria.

**Corolarios de estas tres decisiones (obligatorios, no opcionales):**

- **Los saldos NUNCA se almacenan.** No existe columna `balance` en ninguna tabla. Todo saldo se deriva sumando `entries`. Una columna de saldo mutable crea una segunda fuente de verdad que se desincroniza ante cualquier bug, borrado parcial o escritura fuera del backend.
- **El ledger es inmutable.** Las correcciones se hacen creando una transacción de reversa (`reverses_transaction_id`), no con `UPDATE`/`DELETE`. Esto preserva el historial de qué pasó realmente y cuándo se corrigió.
- **El dinero se maneja en enteros de centavos** (`BigInt`), nunca en punto flotante ni decimal.

### Reglas duras del documento

Estas dos reglas aplican a toda la capa de datos y no admiten excepción:

**RD1 — Todo objeto de base de datos vive en una migración versionada de Prisma.**
Tablas, enums, extensiones, índices, constraints, funciones, triggers, policies RLS y seeds. **Ningún objeto se crea desde la UI de Supabase.** Un objeto creado a mano existe en producción pero no en el contenedor de tests, lo que produce tests que pasan por la razón equivocada mientras producción se comporta distinto. Prototipar en la UI de Supabase es aceptable; dejarlo ahí no. Corolario: **`prisma db push` está prohibido** en cualquier punto del flujo — no transporta triggers, funciones ni constraints escritos a mano.

**Flujo obligatorio de migración — `prisma migrate dev` también está prohibido.**

| Paso | Acción |
|---|---|
| 1 | Crear a mano la carpeta de migración, con timestamp UTC |
| 2 | Escribir el `.sql` completo a mano |
| 3 | Reflejar el cambio en `schema.prisma` manualmente |
| 4 | Aplicar con `npx prisma migrate deploy` |
| 5 | Verificar con `npm run db:check-sync` |

**Por qué no `migrate dev`.** Usa una *shadow database* que crea y destruye reaplicando todo el historial de migraciones desde cero. Esa base nunca tiene el stub de `auth` (§3.8), que por decisión vive fuera de las migraciones. Falla con `P3006` desde la segunda migración del proyecto en adelante. **`--create-only` tampoco sirve:** también usa una shadow database efímera en cuanto existe una migración previa, y no hay flag para desactivarlo.

**`prisma migrate diff` está igualmente prohibido**, y `multiSchema` **nunca debe activarse**: con esa bandera, `prisma migrate reset` borra `auth.users`, lo que tumba la validación estructural y toda la suite posterior con errores que aparentan ser bugs de migración. Si aparece un error de FK cruzada hacia `auth`, `multiSchema` no es la solución.

**Qué se pierde y cómo se compensa.** `migrate dev` validaba que el historial completo se pudiera reaplicar desde cero. Esa cobertura se conserva en la verificación estructural, que ejecuta `migrate reset` + `migrate deploy` contra la base real dentro de la suite. Deja de ser un paso previo del comando y pasa a ser un test.

**Riesgo residual del paso 3.** Como el `.sql` y el `schema.prisma` se escriben por separado, nada de Prisma garantiza que coincidan. Lo cubre `db:check-sync`, un script propio que compara el `schema.prisma` contra `information_schema` con `pg` directo, sin usar ninguna herramienta de diff de Prisma. Corre en cada cambio de esquema, no solo al final.

**RD2 — RLS cubre exclusivamente propiedad de filas.**
Las policies de §3.8 responden únicamente a "¿esta fila pertenece a este usuario?". Los invariantes contables (suma-cero, tipo de cuenta de un `budget_entry`, inmutabilidad del ledger, saldo cero para archivar) **no son expresables como policy** — una policy no puede validar una agregación sobre filas hermanas. Esos invariantes viven en los triggers de §3.4. Son dos mecanismos distintos y ninguno sustituye al otro. Esto precisa el alcance de lo enunciado en §3 sobre RLS como espejo de la autorización en código: el espejo aplica a la propiedad de los datos, no a las reglas contables.

---

## 3.2 Semántica de signos

El signo de `entries.amount_cents` es puramente direccional y no significa "bueno/malo" ni "tengo/no tengo":

- **Positivo** → el dinero *llegó* a esta cuenta.
- **Negativo** → el dinero *salió* de esta cuenta.

De esta convención se derivan los saldos naturales por tipo de cuenta, y **la regla de presentación que la UI debe aplicar**:

| `type` | Qué representa | Saldo natural | Cómo lo pinta la UI |
|---|---|---|---|
| `asset` | Dinero propio disponible (Nu, efectivo, débito) | Positivo | Tal cual, es lo que tienes |
| `receivable` | Dinero que un tercero te debe (préstamos otorgados) | Positivo | Tal cual, etiqueta **"te deben"** |
| `liability` | Deuda tuya (tarjeta de crédito) | Negativo | Valor absoluto, etiqueta "debes" |
| `income` | Fuentes de ingreso (sueldo, freelance) | Negativo | Valor absoluto, etiqueta "ingresos" |
| `expense` | Categorías de gasto (Wifi, Comida) | Positivo | Tal cual, es lo que gastaste acumulado |
| `equity` | Ancla contable de saldo inicial | Variable | **Nunca se muestra al usuario** |

**Regla dura para la UI y para el MCP:** la transformación de signo depende **exclusivamente** del `type` de la cuenta. No se hardcodea por nombre de cuenta ni por contexto. El signo crudo de la base de datos nunca se expone al usuario final.

**`asset` vs `receivable` — la distinción importa en los cálculos, no solo en la UI.**
`receivable` es dinero tuyo que **no puedes gastar hoy**. Por eso se separa de `asset` en lugar de ser un subtipo cosmético:

| Cálculo | ¿Incluye `receivable`? |
|---|---|
| Dinero disponible para asignar (`fn_unassigned_funds`, §3.9) | **No** — no puedes presupuestar lo que no tienes en mano |
| Patrimonio neto | **Sí** — sigue siendo tuyo |
| Archivar cuenta con saldo cero (R8) | **Sí** — archivar un préstamo pendiente ocultaría dinero por cobrar |

**Ejemplos canónicos** (todos suman cero):

| Caso | Entries |
|---|---|
| Ingreso de nómina $10,000 | `Nu +1000000`, `Sueldo(income) −1000000` |
| Wifi $700 pagado con TDC | `TDC −70000`, `Gasto:Wifi +70000` |
| Pago de tarjeta $700 desde Nu | `Nu −70000`, `TDC +70000` |
| Préstamo de $500 a un tercero | `Nu −50000`, `PorCobrar:Fer(receivable) +50000` |
| El tercero paga el préstamo | `Nu +50000`, `PorCobrar:Fer −50000` |
| Cena $800 con TDC, mitad prestada | `TDC −80000`, `Gasto:Comida +40000`, `PorCobrar:Fer +40000` |
| **Préstamo incobrable de $500** | `PorCobrar:Fer −50000`, `Gasto:Pérdidas +50000` |
| Saldo inicial (onboarding) | `Nu +1000000`, `TDC −250000`, `Efectivo +80000`, `SaldoInicial(equity) −830000` |
| Reversa de una transacción errónea | Los mismos entries del original, con todos los signos invertidos |

**Notas sobre dos casos que se prestan a error:**

- El **pago de tarjeta no toca ninguna categoría de gasto**: el gasto ya se contabilizó cuando se hizo la compra. Contabilizarlo dos veces es el error más común en este dominio.
- El **préstamo incobrable** es el único momento en que un préstamo impacta el presupuesto. Mientras es cobrable, el dinero solo cambió de forma (de `asset` a `receivable`) y no es un gasto. Al declararlo incobrable, se salda la cuenta `receivable` contra una categoría de gasto (típicamente "Pérdidas"), y ahí sí se refleja como gasto real del periodo en que se declaró.

---

## 3.3 Schema completo

Todas las tablas de esta capa usan `uuid` como PK (generado por la aplicación o `gen_random_uuid()`), y todas cuelgan de `profiles.id` — que a su vez es igual a `auth.users.id` de Supabase (ver §3.7).

Convención de nombres: se documenta aquí en `snake_case` (nombre físico en Postgres). El mapeo desde Prisma se hace con `@map` / `@@map`.

### Política de borrado

**Soft delete generalizado.** Ninguna tabla de esta capa se borra en duro:

| Tabla | Mecanismo |
|---|---|
| `accounts` | `archived_at` (ya existía) |
| `budget_periods` | `deleted_at` |
| `budget_entries` | `deleted_at` |
| `recurring_templates` | `deleted_at` |
| `profiles` | `deleted_at` — **columna propiedad de `TASK-auth`**, ver §3.14 (coordinación) |
| `transactions` | **Excepción — sin soft delete** |
| `entries` | **Excepción — sin soft delete** |

**Por qué `transactions` y `entries` son la excepción, explícitamente:**

1. Ya están cubiertas por inmutabilidad total (R5 y R6): no admiten `UPDATE` de campos contables ni `DELETE`. Un `deleted_at` sería un tercer mecanismo redundante sobre algo que ya no se puede borrar.
2. **Un `deleted_at` en `entries` rompería la validación de suma-cero.** Si las consultas excluyeran entries "borrados", una transacción dejaría de sumar cero y todos los saldos derivados quedarían inconsistentes. Si no los excluyeran, la columna no serviría de nada. No hay una tercera opción coherente.

**El único camino de corrección del ledger es la transacción de reversa.** No existe ventana de gracia, ni borrado suave, ni "deshacer" dentro de los primeros N minutos. Una captura errónea se corrige creando su reversa, lo que deja ambos registros visibles en el historial. Esto es deliberado: un ledger financiero que permite borrar es un ledger cuyos reportes históricos no son reproducibles.

**Consecuencia para todas las consultas:** cualquier lectura de `budget_periods`, `budget_entries` o `recurring_templates` debe filtrar `deleted_at IS NULL`. Los índices únicos parciales de esas tablas incluyen esa condición.

### `updated_at` — decisión consciente

`updated_at` lo maneja **Prisma a nivel de aplicación** (`@updatedAt`), **sin trigger** de Postgres.

**Racional:** mantener el campo en un solo lugar; el flujo normal de escritura pasa siempre por Prisma.

**Consecuencia asumida y documentada:** una escritura manual desde el SQL editor de Supabase, o desde una migración, **no** actualiza `updated_at`. El campo es confiable como marca de "última modificación vía aplicación", no como marca de "última modificación de la fila". No debe usarse para sincronización, invalidación de cache ni resolución de conflictos.

---

#### Enums (tipos de Postgres)

```sql
CREATE TYPE account_type AS ENUM (
  'asset', 'receivable', 'liability', 'income', 'expense', 'equity'
);
CREATE TYPE rollover_type AS ENUM ('accumulate', 'reset');
CREATE TYPE budget_entry_source AS ENUM ('manual', 'rollover');
```

---

#### Tabla `accounts`

Tabla polimórfica: contiene cuentas reales, cuentas por cobrar, fuentes de ingreso, categorías de gasto y el ancla de saldo inicial. El `type` determina el comportamiento.

| Columna | Tipo | Null | Default | Descripción |
|---|---|---|---|---|
| `id` | `uuid` | NO | `gen_random_uuid()` | PK |
| `user_id` | `uuid` | NO | — | FK → `profiles.id`, **`ON DELETE RESTRICT`** |
| `name` | `text` | NO | — | Nombre visible ("Nu", "Gasto: Wifi") |
| `type` | `account_type` | NO | — | Determina semántica de signo y comportamiento |
| `currency` | `char(3)` | NO | `'MXN'` | ISO 4217 |
| `rollover_type` | `rollover_type` | SÍ | `NULL` | Obligatorio si `type='expense'`, prohibido en cualquier otro caso |
| `is_system` | `boolean` | NO | `false` | `true` → oculta de UI y de todos los reportes |
| `archived_at` | `timestamptz` | SÍ | `NULL` | Soft delete |
| `created_at` | `timestamptz` | NO | `now()` | |
| `updated_at` | `timestamptz` | NO | `now()` | Gestionado por Prisma |

**Constraints:**

```sql
CONSTRAINT accounts_rollover_consistency CHECK (
  (type = 'expense' AND rollover_type IS NOT NULL)
  OR (type <> 'expense' AND rollover_type IS NULL)
)

CONSTRAINT accounts_currency_format CHECK (currency ~ '^[A-Z]{3}$')

CONSTRAINT accounts_system_is_equity CHECK (is_system = false OR type = 'equity')

CREATE UNIQUE INDEX accounts_user_name_active_uniq
  ON accounts (user_id, lower(name))
  WHERE archived_at IS NULL;
```

**Índices:**

```sql
CREATE INDEX accounts_user_idx      ON accounts (user_id);
CREATE INDEX accounts_user_type_idx ON accounts (user_id, type) WHERE archived_at IS NULL;
```

**Notas de comportamiento:**
- Una cuenta con `type='expense'` **es** una categoría de presupuesto.
- El ancla de saldo inicial es una única cuenta por usuario con `type='equity'`, `is_system=true`, sembrada al crear el usuario (§3.12).

---

#### Tabla `transactions`

El evento contable. No contiene montos. **Sin soft delete** (ver política de borrado).

| Columna | Tipo | Null | Default | Descripción |
|---|---|---|---|---|
| `id` | `uuid` | NO | `gen_random_uuid()` | PK |
| `user_id` | `uuid` | NO | — | FK → `profiles.id`, **`ON DELETE RESTRICT`** |
| `booked_at` | `date` | NO | — | Fecha **local** en que ocurrió. Sin hora, sin zona (ver §3.6) |
| `description` | `text` | NO | — | Texto libre. Único campo actualizable |
| `idempotency_key` | `uuid` | SÍ | `NULL` | Generada por el cliente. **Nullable**. Ver §3.5 |
| `reverses_transaction_id` | `uuid` | SÍ | `NULL` | FK → `transactions.id`. Marca esta transacción como reversa de otra |
| `created_at` | `timestamptz` | NO | `now()` | Cuándo se capturó (distinto de `booked_at`) |

**Constraints:**

```sql
CONSTRAINT transactions_no_self_reversal CHECK (id <> reverses_transaction_id)

CREATE UNIQUE INDEX transactions_reverses_uniq
  ON transactions (reverses_transaction_id)
  WHERE reverses_transaction_id IS NOT NULL;

CREATE UNIQUE INDEX transactions_idempotency_uniq
  ON transactions (user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
```

**Índices:**

```sql
CREATE INDEX transactions_user_booked_idx  ON transactions (user_id, booked_at DESC);
CREATE INDEX transactions_user_created_idx ON transactions (user_id, created_at DESC);
```

---

#### Tabla `entries`

El ledger de dinero. Única fuente de verdad de todo saldo. **Sin soft delete.**

| Columna | Tipo | Null | Default | Descripción |
|---|---|---|---|---|
| `id` | `uuid` | NO | `gen_random_uuid()` | PK |
| `transaction_id` | `uuid` | NO | — | FK → `transactions.id`, `ON DELETE RESTRICT` |
| `user_id` | `uuid` | NO | — | FK → `profiles.id`, **`ON DELETE RESTRICT`**. Desnormalizado a propósito (§3.8) |
| `account_id` | `uuid` | NO | — | FK → `accounts.id`, `ON DELETE RESTRICT` |
| `amount_cents` | `bigint` | NO | — | Con signo. Centavos, nunca unidades |
| `created_at` | `timestamptz` | NO | `now()` | |

**Constraints:**

```sql
CONSTRAINT entries_amount_nonzero CHECK (amount_cents <> 0)
```

**Índices:**

```sql
CREATE INDEX entries_transaction_idx  ON entries (transaction_id);
CREATE INDEX entries_account_idx      ON entries (account_id);
CREATE INDEX entries_user_account_idx ON entries (user_id, account_id);
```

**`ON DELETE RESTRICT` en las tres FKs es deliberado.** Con el borrado de usuario resuelto como soft delete (§3.3), no existe ninguna vía legítima de borrado en cascada sobre el ledger. Cualquier intento de `DELETE` que llegue hasta aquí es un error, y `RESTRICT` lo detiene antes de que R5 tenga que intervenir.

---

#### Tabla `budget_periods`

Las quincenas (o el periodo que el usuario defina). **Las fechas son datos, no reglas.**

| Columna | Tipo | Null | Default | Descripción |
|---|---|---|---|---|
| `id` | `uuid` | NO | `gen_random_uuid()` | PK |
| `user_id` | `uuid` | NO | — | FK → `profiles.id`, **`ON DELETE RESTRICT`** |
| `starts_on` | `date` | NO | — | Inclusivo |
| `ends_on` | `date` | NO | — | Inclusivo |
| `closed_at` | `timestamptz` | SÍ | `NULL` | `NULL` = abierto. Con fecha = rollover ya materializado |
| `deleted_at` | `timestamptz` | SÍ | `NULL` | Soft delete |
| `created_at` | `timestamptz` | NO | `now()` | |
| `updated_at` | `timestamptz` | NO | `now()` | Gestionado por Prisma |

**Constraints:**

```sql
CONSTRAINT budget_periods_valid_range CHECK (ends_on >= starts_on)

-- Requiere: CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE budget_periods ADD CONSTRAINT budget_periods_no_overlap
  EXCLUDE USING gist (
    user_id WITH =,
    daterange(starts_on, ends_on, '[]') WITH &&
  ) WHERE (deleted_at IS NULL);
```

El predicado `WHERE (deleted_at IS NULL)` es indispensable: sin él, un periodo borrado suavemente seguiría bloqueando la creación de uno nuevo en el mismo rango.

**Índices:**

```sql
CREATE INDEX budget_periods_user_range_idx ON budget_periods (user_id, starts_on DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX budget_periods_user_open_idx  ON budget_periods (user_id)
  WHERE closed_at IS NULL AND deleted_at IS NULL;
```

**Los huecos entre periodos están PERMITIDOS.**
No existe regla ni validación que exija que un periodo empiece el día siguiente al anterior. Un usuario puede tener `[1–15 ago]` y `[20–31 ago]` sin que la base ni el Service lo impidan. Las transacciones cuyo `booked_at` cae en el hueco simplemente no pertenecen a ningún periodo, y aparecen en `fn_transactions_without_period` (§3.9) para que el usuario decida. Ese mecanismo ya cubre el escenario completo; una regla de "sin huecos" solo agregaría fricción sin aportar garantía.

**Definición de "el periodo siguiente"** (usada por el algoritmo de cierre, §3.10):

> El periodo del mismo usuario, no borrado, con el `starts_on` **más pequeño que sea estrictamente mayor** al `ends_on` del periodo que se está cerrando.

Es determinista incluso con huecos, gracias al constraint de no-traslape: no puede haber dos periodos candidatos con el mismo `starts_on`.

**Edición de fechas:** permitida solo mientras `closed_at IS NULL` (regla R10, §3.4).

---

#### Tabla `budget_entries`

El ledger de presupuesto. Registra asignaciones de dinero a categorías. **No mueve dinero real.**

| Columna | Tipo | Null | Default | Descripción |
|---|---|---|---|---|
| `id` | `uuid` | NO | `gen_random_uuid()` | PK |
| `user_id` | `uuid` | NO | — | FK → `profiles.id`, **`ON DELETE RESTRICT`** |
| `period_id` | `uuid` | NO | — | FK → `budget_periods.id`, `ON DELETE RESTRICT` |
| `category_id` | `uuid` | NO | — | FK → `accounts.id` con `type='expense'`, `ON DELETE RESTRICT` |
| `amount_cents` | `bigint` | NO | — | Puede ser negativo (desasignar, o arrastre de sobregiro) |
| `source` | `budget_entry_source` | NO | `'manual'` | `manual` = el usuario asignó. `rollover` = materializado al cerrar el periodo anterior |
| `note` | `text` | SÍ | `NULL` | Ej. "rollover Comida desde 2–16 ago" |
| `deleted_at` | `timestamptz` | SÍ | `NULL` | Soft delete |
| `created_at` | `timestamptz` | NO | `now()` | |
| `updated_at` | `timestamptz` | NO | `now()` | Gestionado por Prisma |

**Constraints:**

```sql
CONSTRAINT budget_entries_amount_nonzero CHECK (amount_cents <> 0)

-- Máximo un entry de rollover vigente por (periodo, categoría)
CREATE UNIQUE INDEX budget_entries_rollover_uniq
  ON budget_entries (period_id, category_id)
  WHERE source = 'rollover' AND deleted_at IS NULL;
```

**Índices:**

```sql
CREATE INDEX budget_entries_period_idx          ON budget_entries (period_id)
  WHERE deleted_at IS NULL;
CREATE INDEX budget_entries_category_idx        ON budget_entries (category_id)
  WHERE deleted_at IS NULL;
CREATE INDEX budget_entries_user_period_cat_idx ON budget_entries (user_id, period_id, category_id)
  WHERE deleted_at IS NULL;
```

**Mutabilidad ligada al estado del periodo:** un `budget_entry` solo puede editarse o borrarse suavemente si su periodo tiene `closed_at IS NULL`. Aplica por igual a `source='manual'` y a `source='rollover'` (regla R11, §3.4). Un periodo cerrado ya propagó su rollover al siguiente; modificar sus asignaciones después haría que el monto arrastrado no corresponda a nada.

---

#### Tabla `recurring_templates`

**Solo recordatorios.** Nunca generan transacciones automáticamente; el usuario confirma y en ese momento se crea la transacción real.

| Columna | Tipo | Null | Default | Descripción |
|---|---|---|---|---|
| `id` | `uuid` | NO | `gen_random_uuid()` | PK |
| `user_id` | `uuid` | NO | — | FK → `profiles.id`, **`ON DELETE RESTRICT`** |
| `name` | `text` | NO | — | "Wifi Totalplay" |
| `account_id` | `uuid` | SÍ | `NULL` | FK → `accounts.id`. Cuenta de pago sugerida |
| `category_id` | `uuid` | NO | — | FK → `accounts.id` con `type='expense'` |
| `amount_cents` | `bigint` | NO | — | Monto **estimado**, siempre positivo |
| `day_of_month` | `smallint` | NO | — | 1–31 |
| `next_due_on` | `date` | NO | — | Próxima fecha esperada |
| `last_confirmed_on` | `date` | SÍ | `NULL` | Última vez que el usuario confirmó |
| `is_active` | `boolean` | NO | `true` | |
| `deleted_at` | `timestamptz` | SÍ | `NULL` | Soft delete |
| `created_at` | `timestamptz` | NO | `now()` | |
| `updated_at` | `timestamptz` | NO | `now()` | Gestionado por Prisma |

**Constraints:**

```sql
CONSTRAINT recurring_day_range       CHECK (day_of_month BETWEEN 1 AND 31)
CONSTRAINT recurring_amount_positive CHECK (amount_cents > 0)
```

**Índices:**

```sql
CREATE INDEX recurring_user_due_idx ON recurring_templates (user_id, next_due_on)
  WHERE is_active = true AND deleted_at IS NULL;
```

**Regla de cálculo de `next_due_on` — día inexistente en el mes destino:**

Si `day_of_month` no existe en el mes objetivo, `next_due_on` es el **primer día del mes siguiente**.

| `day_of_month` | Mes objetivo | `next_due_on` |
|---|---|---|
| 31 | Febrero (año no bisiesto) | 1 de marzo |
| 31 | Febrero (año bisiesto) | 1 de marzo |
| 30 | Febrero | 1 de marzo |
| 31 | Abril | 1 de mayo |
| 31 | Mayo | 31 de mayo |
| 15 | Cualquier mes | día 15 de ese mes |

**Racional:** desplazar hacia adelante (no hacia el día 28) evita que un recordatorio se dispare antes de que el cargo real pudiera haber ocurrido. Un recordatorio tardío es un inconveniente; uno prematuro genera una confirmación de algo que aún no pasó.

**Regla de avance:** el cálculo parte siempre de `day_of_month` aplicado a un mes objetivo derivado de `last_confirmed_on`, **nunca** de `next_due_on + 1 mes`. Así, un desplazamiento por mes corto (ej. febrero → 1 de marzo) no arrastra el corrimiento a los meses posteriores: el siguiente vuelve a ser el día 31.

**Cuál es el mes objetivo** — depende de comparar el día de `last_confirmed_on` contra `day_of_month`:

| Condición | Mes objetivo |
|---|---|
| `día(last_confirmed_on) < day_of_month` | El **mismo** mes de `last_confirmed_on` |
| `día(last_confirmed_on) >= day_of_month` | El mes **siguiente** al de `last_confirmed_on` |

**Por qué no es siempre "el mes siguiente".** Un usuario puede confirmar un pago con retraso, ya entrado el mes posterior al del vencimiento. Ejemplo: `day_of_month = 31`, y el usuario confirma el **1 de marzo** el cargo que venció el 31 de enero. Si el mes objetivo fuera siempre el siguiente al de la confirmación, `next_due_on` saltaría a abril y **se perdería el vencimiento del 31 de marzo** — un ciclo completo omitido cada vez que se confirma tarde. Con la regla de arriba, como `1 < 31`, el mes objetivo es marzo y el resultado correcto es el 31 de marzo.

*(Una versión previa de este documento decía simplemente "el mes calendario siguiente al de `last_confirmed_on`". Esa lectura literal es incorrecta y contradice el comportamiento esperado del caso anterior.)*

**Estado de "ya se generó este mes":** se deriva comparando `last_confirmed_on` contra `next_due_on`. No requiere tabla ni columna adicional.

---

### Convención de nombres en Prisma

Normativa. Los nombres no se eligen por archivo ni por criterio del implementador.

| Tabla física (Postgres) | Modelo en `schema.prisma` | Acceso desde el cliente | Mapeo |
|---|---|---|---|
| `accounts` | `Account` | `prisma.account` | `@@map("accounts")` |
| `transactions` | `Transaction` | `prisma.transaction` | `@@map("transactions")` |
| `entries` | `Entry` | `prisma.entry` | `@@map("entries")` |
| `budget_periods` | `BudgetPeriod` | `prisma.budgetPeriod` | `@@map("budget_periods")` |
| `budget_entries` | `BudgetEntry` | `prisma.budgetEntry` | `@@map("budget_entries")` |
| `recurring_templates` | `RecurringTemplate` | `prisma.recurringTemplate` | `@@map("recurring_templates")` |

**Reglas:**

1. **Modelo en `PascalCase` singular; tabla en `snake_case` plural.** El puente es `@@map`. Es la convención idiomática de Prisma y la que asume la suite de tests.
2. **Cada columna lleva `@map` a su nombre físico en `snake_case`.** En el modelo se escribe `amountCents`, `bookedAt`, `userId`, `archivedAt`, `deletedAt`, `idempotencyKey`, `reversesTransactionId`, `dayOfMonth`, `nextDueOn`, `lastConfirmedOn`, `isActive`, `isSystem`, `rolloverType`, `closedAt`. En la base son `amount_cents`, `booked_at`, etc.
3. **El acceso desde el cliente es `camelCase` de la primera letra del modelo.** Prisma lo deriva automáticamente: `BudgetPeriod` → `prisma.budgetPeriod`. No se renombra con `@@map` a nivel de cliente.
4. **Los enums de Postgres se declaran como `enum` de Prisma con `@@map`:** `AccountType` → `account_type`, `RolloverType` → `rollover_type`, `BudgetEntrySource` → `budget_entry_source`. Sus valores conservan el nombre físico en minúsculas (`asset`, `receivable`, …) vía `@map`.

**`prisma.transaction` NO colisiona con `prisma.$transaction()`.**

Es la duda razonable que aparece al ver el modelo `Transaction`, y la respuesta es que conviven sin problema:

- Los métodos del cliente que no son modelos llevan **prefijo `$`**: `$transaction`, `$connect`, `$disconnect`, `$queryRaw`, `$executeRaw`, `$on`, `$extends`. Prisma reserva ese prefijo precisamente para separar su API de los delegates de modelo.
- Un modelo llamado `Transaction` genera la propiedad `transaction` (sin `$`), que es un espacio de nombres distinto. `prisma.transaction.findMany()` y `prisma.$transaction([...])` son dos propiedades diferentes del mismo objeto.
- Prisma **sí** rechaza nombres de modelo que colisionarían de verdad, y `Transaction` no está en esa lista.

Uso simultáneo, que es el caso normal en esta capa (S-R1 de U24 exige crear transacción y entries en la misma transacción de DB):

```ts
await prisma.$transaction(async (tx) => {
  const t = await tx.transaction.create({ data: { /* ... */ } });
  await tx.entry.createMany({ data: entries.map(e => ({ ...e, transactionId: t.id })) });
});
```

**No renombrar el modelo `Transaction` a `LedgerTransaction`, `Txn` o similar "para evitar la colisión".** No hay colisión que evitar, el rename rompe la suite de tests, y desalinea el nombre del modelo respecto al de la tabla y al del dominio.

---

## 3.4 Reglas de integridad que NO viven en el schema

Se implementan como triggers/funciones en Postgres, en **migraciones SQL raw** (RD1).

**Por qué existen aunque el Service ya valide:** el Service protege lo que pasa por el Service. Estos triggers protegen contra migraciones, seeds, correcciones manuales y bugs futuros en cualquier repositorio. Es la misma lógica de defensa en profundidad que §3 documenta para RLS. **No es duplicación: es la red de último recurso.** El Service debe validar antes y lanzar la excepción tipada; el trigger nunca debería dispararse en operación normal.

**Cada `RAISE EXCEPTION` usa un `ERRCODE` distinguible** para que el Service mapee cada violación a su excepción tipada sin parsear texto de mensaje. Los códigos sugeridos van en el rango `P1001`–`P1011`, uno por regla.

**Estructura física: 9 triggers, verificados por lista nominal.**

Las once reglas R1–R11 **no** se traducen a once triggers. R1, R2, R4 y el primer punto de disparo de R9 comparten una única función diferida sobre `entries` — se evalúan juntas al `COMMIT` y no tiene sentido separarlas. El desglose real es:

| # | Trigger | Tabla | Timing y eventos | Reglas que implementa |
|---|---|---|---|---|
| 1 | `trg_entries_deferred_checks` | `entries` | `AFTER INSERT OR UPDATE OR DELETE`, `CONSTRAINT TRIGGER DEFERRABLE INITIALLY DEFERRED` | R1, R2, R4, R9 (disparo sobre entries) |
| 2 | `trg_entries_owner_consistency` | `entries` | `BEFORE INSERT OR UPDATE`, inmediato | R3 |
| 3 | `trg_entries_immutable` | `entries` | `BEFORE UPDATE OR DELETE` | R5 |
| 4 | `trg_transactions_immutable` | `transactions` | `BEFORE UPDATE OR DELETE` | R6 |
| 5 | `trg_reversal_has_entries` | `transactions` | `AFTER INSERT`, `CONSTRAINT TRIGGER DEFERRABLE INITIALLY DEFERRED` | R9 (disparo sobre transactions) |
| 6 | `trg_accounts_archive_requires_zero_balance` | `accounts` | `BEFORE UPDATE` | R8 |
| 7 | `trg_budget_entry_category_is_expense` | `budget_entries` | `BEFORE INSERT OR UPDATE` | R7 |
| 8 | `trg_budget_entries_locked_when_period_closed` | `budget_entries` | `BEFORE INSERT OR UPDATE OR DELETE` | R11 |
| 9 | `trg_budget_period_dates_locked_when_closed` | `budget_periods` | `BEFORE UPDATE` | R10 |

**Los nombres de arriba son normativos.** La verificación estructural (T-L03/T-L08) compara **nombre, tabla, timing, eventos y regla** contra esta tabla — no un conteo agregado. La constante `EXPECTED_TRIGGERS` del test es un espejo de esta lista: si una cambia, la otra tiene que cambiar en la misma vuelta.

*(Una versión previa de este documento fijaba un conteo normativo de "12 triggers", derivado de asumir uno por regla más el segundo disparo de R9. Ese número nunca se desglosó y era incorrecto: R1, R2, R4 y R9a comparten trigger. La verificación por conteo también era frágil — cualquier fusión o división legítima de triggers la rompía sin que nada estuviera mal. Se reemplazó por la lista nominal de arriba.)*

---

**R1 — `entries_balance_zero` (el invariante central)**

- **Qué valida:** para toda transacción con al menos un entry, `SUM(amount_cents) = 0`.
- **Cuándo dispara:** `AFTER INSERT OR UPDATE OR DELETE ON entries`, `FOR EACH ROW`, como **`CONSTRAINT TRIGGER ... DEFERRABLE INITIALLY DEFERRED`**.
- **Por qué diferido:** los entries se insertan de uno en uno. Una validación inmediata fallaría en el primer entry, que por definición no suma cero. Al diferirla, se evalúa al `COMMIT`.
- **Manejo del caso vacío:** si la transacción quedó sin ningún entry, `SUM(amount_cents)` devuelve `NULL`, no `0`. **La función debe tratar `NULL` como aprobado**, no como violación:

  ```sql
  SELECT SUM(amount_cents) INTO v_total FROM entries WHERE transaction_id = v_tx_id;
  IF v_total IS NOT NULL AND v_total <> 0 THEN
    RAISE EXCEPTION 'Ledger desbalanceado: %', v_total USING ERRCODE = 'P1001';
  END IF;
  ```

  Sin este manejo, un `COALESCE(SUM(...), 0)` mal colocado o una comparación directa contra `NULL` produce comportamiento distinto al esperado. El caso vacío lo cubre R2, no R1.
- **Si falla:** rollback total de la transacción de base de datos. Se traduce a `UnbalancedTransactionException`.

**R2 — `entries_minimum_two`**

- **Qué valida:** una transacción tiene **0 entries, o bien 2 o más**. Nunca exactamente 1.
- **Cuándo dispara:** misma función diferida que R1.
- **Por qué se permite 0 — no es una decisión, es estructural.** El trigger vive sobre `entries`. Una transacción sin ningún entry **nunca lo dispara**, así que la base de datos no tiene forma de rechazarla aunque quisiera. Documentarlo como "se permite" es reconocer el hecho, no elegirlo.

  *(El racional anterior justificaba el caso vacío por el borrado en cascada. Ese argumento ya no aplica: con soft delete y todas las FKs en `ON DELETE RESTRICT`, los entries no se pueden borrar nunca, por lo que una transacción no puede pasar de N entries a 0.)*
- **Por qué se prohíbe exactamente 1:** un solo entry no puede sumar cero, porque `entries_amount_nonzero` ya prohíbe el monto cero. Validarlo explícitamente da un mensaje claro en vez de uno confuso desde R1.
- **Regla del Service (obligatoria, la base no puede darla):** una `transaction` y sus `entries` se crean **siempre dentro de la misma transacción de base de datos**, sin excepción. Es la única garantía real contra transacciones huérfanas.

  **Efecto colateral concreto si se incumple:** una transacción huérfana que traiga `idempotency_key` **quema esa llave**. El índice único ya está ocupado, y un reintento legítimo posterior recibiría de vuelta un registro vacío en lugar de crear la transacción real. El usuario vería su gasto como "ya registrado" sin que exista ningún movimiento.
- **Si falla:** rollback + excepción (`ERRCODE = 'P1002'`).

**R3 — `entries_owner_consistency`**

- **Qué valida:** `entries.user_id = transactions.user_id` **y** `entries.user_id = accounts.user_id`.
- **Cuándo dispara:** `BEFORE INSERT OR UPDATE ON entries`, `FOR EACH ROW`, inmediato.
- **Por qué:** el `user_id` de `entries` está desnormalizado. Sin esta validación, un entry podría tener un `user_id` que no corresponda ni a su transacción ni a su cuenta, y las policies RLS y las funciones de §3.9 devolverían resultados incorrectos. También impide crear un entry apuntando a la cuenta de otro usuario.
- **Si falla:** rollback + excepción (`P1003`).

**R4 — `entries_single_currency`**

- **Qué valida:** todas las cuentas involucradas en una misma transacción tienen la misma `currency`.
- **Cuándo dispara:** misma función diferida que R1.
- **Por qué:** mientras no exista soporte multi-moneda (§3.14), mezclar MXN y USD produciría una suma-cero sin sentido económico.
- **Si falla:** rollback + excepción (`P1004`).

**R5 — `entries_immutable`**

- **Qué valida:** bloquea `UPDATE` y `DELETE` sobre `entries`.
- **Cuándo dispara:** `BEFORE UPDATE OR DELETE ON entries`, `FOR EACH ROW`.
- **Sin excepciones.** Con el borrado de usuario resuelto como soft delete y todas las FKs en `ON DELETE RESTRICT`, no existe cascade legítimo que deba eximirse. Esta regla ya no tiene casos especiales.
- **Si falla:** rollback + excepción (`P1005`). La corrección correcta es una transacción de reversa.

**R6 — `transactions_immutable`**

- **Qué valida:** bloquea `UPDATE` sobre `booked_at`, `user_id`, `idempotency_key` y `reverses_transaction_id`; bloquea `DELETE`.
- **Cuándo dispara:** `BEFORE UPDATE OR DELETE ON transactions`, `FOR EACH ROW`.
- **Qué SÍ se permite actualizar:** `description` únicamente. Corregir un typo no altera la contabilidad.
- **Si falla:** rollback + excepción (`P1006`).

**R7 — `budget_entry_category_is_expense`**

- **Qué valida:** `budget_entries.category_id` apunta a una cuenta con `type = 'expense'` y del mismo `user_id`.
- **Cuándo dispara:** `BEFORE INSERT OR UPDATE ON budget_entries`, `FOR EACH ROW`.
- **Por qué:** una FK no puede restringir el `type` de la fila referenciada. Sin esto se podría presupuestar contra una cuenta bancaria.
- **Si falla:** rollback + excepción (`P1007`).

**R8 — `accounts_archive_requires_zero_balance`**

- **Qué valida:** al setear `archived_at`, el saldo derivado debe ser exactamente `0` — **solo para `type IN ('asset', 'receivable', 'liability')`**.
- **Cuándo dispara:** `BEFORE UPDATE ON accounts`, `FOR EACH ROW`, cuando `archived_at` pasa de `NULL` a no-`NULL`.
- **Por qué solo esos tres tipos:** son los que representan dinero que existe ahora. Archivar una cuenta con saldo la desaparece de la UI mientras su dinero sigue contando en los totales, produciendo una diferencia inexplicable. Un `receivable` con saldo pendiente es dinero que alguien te debe: archivarlo lo ocultaría.
- **Por qué `expense`, `income` y `equity` quedan exentos:** su saldo es un **acumulado histórico que crece de forma monótona y nunca vuelve a cero por diseño**. Aplicarles la regla las volvería imposibles de archivar. Archivar una categoría solo la retira de la lista de asignación futura; su historial de gasto permanece intacto y sigue contando en los reportes.
- **Si falla:** rollback + excepción (`P1008`). El usuario debe primero transferir o saldar el balance.

**R9 — `reversal_magnitude_match` (nuevo)**

- **Qué valida:** cuando una transacción tiene `reverses_transaction_id`, su **magnitud** debe coincidir con la del original.
- **Definición operativa de magnitud:** `SUM(amount_cents) FILTER (WHERE amount_cents > 0)`. Como toda transacción suma cero (R1), esta cifra representa el monto total movido y es el único valor comparable entre dos transacciones. *(Comparar "el total invertido" literalmente no es posible: el total de cualquier transacción válida es cero, y cero invertido sigue siendo cero.)*
- **Qué NO valida:** equivalencia cuenta por cuenta. Deliberadamente. Una reversa puede necesitar rutear el dinero por cuentas distintas (ej. el reembolso llega a otra cuenta), y forzar simetría exacta bloquearía correcciones legítimas.
- **Dos puntos de disparo, ambos necesarios:**

  | Punto | Definición | Qué cubre |
  |---|---|---|
  | **Sobre `entries`** | misma función diferida que R1 | La reversa tiene entries y su magnitud no coincide |
  | **Sobre `transactions`** | `AFTER INSERT`, `CONSTRAINT TRIGGER DEFERRABLE INITIALLY DEFERRED`, evaluado solo cuando `reverses_transaction_id IS NOT NULL` | La reversa **no tiene ningún entry** |

  **Por qué el segundo no es opcional.** Con solo el disparo sobre `entries`, una transacción creada con `reverses_transaction_id` y **cero entries se salta la validación por completo**: queda registrada como reversa de otra, **consume el índice único `transactions_reverses_uniq`** — impidiendo que se cree la reversa real — y nunca se valida. Es el mismo hueco estructural que R2 documenta para el caso vacío, pero aquí sí tiene consecuencia contable.

  Al ser diferido, los entries ya existen al `COMMIT`, así que el disparo sobre `transactions` no produce falsos positivos en el flujo normal: solo rechaza reversas que llegan vacías al cierre de la transacción de base de datos.
- **Si falla:** rollback + excepción (`P1009`).

**R10 — `budget_period_dates_locked_when_closed`**

- **Qué valida:** si `closed_at IS NOT NULL`, se bloquea cualquier `UPDATE` de `starts_on` o `ends_on`.
- **Cuándo dispara:** `BEFORE UPDATE ON budget_periods`, `FOR EACH ROW`.
- **Por qué:** un periodo cerrado ya materializó su rollover contra el periodo siguiente y ya determinó qué transacciones le pertenecen. Mover sus fechas después reasignaría transacciones y dejaría el monto arrastrado sin correspondencia.
- **Qué SÍ se permite:** cambiar `closed_at` (reapertura) y `deleted_at`.
- **Si falla:** rollback + excepción (`P1010`).

**R11 — `budget_entries_locked_when_period_closed`**

- **Qué valida:** bloquea `INSERT`, `UPDATE` y `DELETE` sobre un `budget_entry` cuyo periodo tenga `closed_at IS NOT NULL`. Incluye el soft delete (que es un `UPDATE` de `deleted_at`) y aplica por igual a `source='manual'` y `source='rollover'`.
- **Cuándo dispara:** `BEFORE INSERT OR UPDATE OR DELETE ON budget_entries`, `FOR EACH ROW`.
- **Por qué también `INSERT`:** sin cubrirlo, un periodo cerrado no está realmente protegido — se le podría agregar presupuesto nuevo aunque no se pueda modificar el existente. La regla sería "medio inmutable". Además, §3.10 describe el cierre desordenado diciendo que *"el insert del rollover lo bloquea R11"*: esa frase solo es cierta si R11 cubre `INSERT`.

  *(Una versión previa de este documento enumeraba el disparo como `BEFORE UPDATE OR DELETE`, omitiendo `INSERT`. Fue una omisión al redactar §3.4, no una decisión: el resto del documento ya asumía la cobertura completa.)*
- **Por qué es trigger y no validación de Service:** mismo principio que el resto de §3.4. Un fix manual o un seed que modifique asignaciones de un periodo cerrado corrompería el rollover ya propagado, en silencio.
- **Nota sobre reapertura:** reabrir un periodo (setear `closed_at = NULL`) vuelve a habilitar la edición. El algoritmo de reapertura sigue siendo PENDIENTE (§3.14).
- **Si falla:** rollback + excepción (`P1011`).

> **Nota histórica:** una versión previa de este documento incluía una regla "sin huecos entre periodos" (validada en el Service). **Fue eliminada.** Los huecos están permitidos; ver §3.3, `budget_periods`.

---

## 3.5 Idempotencia

**Problema:** el MCP (o el front) manda "registrar gasto de $200", la red se corta antes de recibir la respuesta, el cliente reintenta, y se crean dos transacciones idénticas.

**Mecanismo:**

1. **El cliente genera un UUID v4** por *intención del usuario* (no por intento HTTP) y lo manda en el request.
2. El backend lo persiste en `transactions.idempotency_key`, con índice único parcial sobre `(user_id, idempotency_key)`.
3. La columna es **nullable**: las escrituras internas y las que no provienen de un cliente remoto pueden omitirla. El índice parcial (`WHERE idempotency_key IS NOT NULL`) permite múltiples filas con `NULL`.

**Regla crítica del lado cliente:** el reintento debe reusar **la misma key**. Si el cliente genera una key nueva por cada intento HTTP, el mecanismo no sirve de nada. En el MCP esto significa generar el UUID una sola vez al interpretar la intención del usuario, y conservarlo a través de todos los reintentos.

### Manejo de la carrera — `ON CONFLICT DO NOTHING` + re-select

Dos requests concurrentes con la misma key pueden pasar ambos una verificación previa de existencia. **La estrategia de "intentar el `INSERT` y capturar la violación de unicidad" NO es implementable en Postgres:** una violación de constraint aborta la transacción completa, y cualquier statement posterior falla con `25P02 (current transaction is aborted)`. No es posible hacer el re-select dentro de la misma transacción.

El mecanismo correcto:

```sql
INSERT INTO transactions (id, user_id, booked_at, description, idempotency_key)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL
DO NOTHING
RETURNING id;
```

- Si devuelve una fila → es una escritura nueva. Se insertan los entries y se hace `COMMIT` (respuesta 201).
- Si **no** devuelve ninguna fila → ya existía. La transacción **no** está abortada, así que se hace el `SELECT` de la transacción existente por `(user_id, idempotency_key)` y se devuelve esa (respuesta 200).

**Punto crítico:** el `SELECT` de recuperación debe ejecutarse **después** de que la transacción original haya hecho `COMMIT`; si el otro request aún está en vuelo, la fila existe pero no es visible. En la práctica esto significa que el Service debe manejar el caso "conflicto detectado pero fila aún no visible" con un reintento corto de lectura, o responder `409` para que el cliente reintente. **PENDIENTE:** ver §3.14, punto 4.

**En Prisma:** `ON CONFLICT DO NOTHING` con índice parcial no es expresable vía `createMany({ skipDuplicates: true })` de forma confiable. Se implementa con `$executeRaw` dentro del `prisma.$transaction()` del `Repository`.

---

## 3.6 Manejo de fechas y zona horaria

| Campo | Tipo | Razón |
|---|---|---|
| `transactions.booked_at` | `date` | Es conceptualmente **una fecha local, no un instante**. Guardarlo como `timestamptz` significa que un gasto de las 23:00 en CDMX se almacena como las 05:00 UTC del día siguiente y, al agrupar por periodo, cae en la quincena equivocada. |
| `transactions.created_at` | `timestamptz` | Sí es un instante real: cuándo se capturó. |
| `budget_periods.starts_on` / `ends_on` | `date` | Los límites de la quincena son fechas locales. |
| `budget_periods.closed_at` | `timestamptz` | Instante de la acción de cierre. |
| `recurring_templates.next_due_on` / `last_confirmed_on` | `date` | Fechas locales. |
| Todos los `created_at` / `updated_at` / `deleted_at` / `archived_at` | `timestamptz` | Auditoría. |

### `profiles.timezone` — quién resuelve la zona

Se implementa `profiles.timezone` como **string IANA** (ej. `America/Mexico_City`). Validación: debe existir en `pg_timezone_names`.

> **Coordinación:** la columna vive en `profiles`, tabla propiedad de `TASK-auth`. Ver §3.14 (coordinación entre tareas).

**Reparto de responsabilidad, explícito:**

| Quién | Qué hace |
|---|---|
| **`profiles.timezone`** | Es la **fuente de verdad declarada** de la zona del usuario. Se usa para: renderizar `created_at` y `closed_at` en hora local; calcular "hoy" al proponer la creación de un periodo o al evaluar recordatorios vencidos; y generar reportes con corte diario. |
| **Cliente (front / MCP)** | Resuelve la fecha local **antes** de enviarla y manda `booked_at` como una fecha ya calendarizada (`YYYY-MM-DD`). Nunca manda un instante UTC para que el servidor lo convierta. |
| **Base de datos** | **No convierte nada.** No infiere zona, no aplica `AT TIME ZONE` sobre `booked_at` (que es `date` y no tiene zona), y ninguna función de §3.9 usa `now()` para determinar a qué periodo pertenece una transacción. |
| **Service** | Cuando necesita "hoy" del usuario (ej. detectar periodos vencidos), lo calcula con `profiles.timezone`, no con la hora del servidor ni con `now()::date`. |

**Regla:** la agrupación por periodo presupuestal **siempre** usa `booked_at`, nunca una conversión desde UTC.

**Por qué `booked_at` sigue siendo `date` aunque exista `profiles.timezone`:** un usuario que viaja o cambia de zona no debe ver sus gastos pasados reasignados a otros días. La fecha se fija en el momento de la captura y no se recalcula jamás.

---

## 3.7 Conexión con la capa de Auth (§2 y §3)

Esta sección **describe** cómo se enlaza con lo ya documentado en Auth; no lo modifica.

**Cadena de identidad:**

```
auth.users (Supabase Auth)
   └── id (uuid, claim `sub` del JWT)
        └── profiles.id  (relación 1:1, documentada en TASK-auth)
             └── accounts.user_id            (ON DELETE RESTRICT)
             └── transactions.user_id        (ON DELETE RESTRICT)
             └── entries.user_id             (ON DELETE RESTRICT)
             └── budget_periods.user_id      (ON DELETE RESTRICT)
             └── budget_entries.user_id      (ON DELETE RESTRICT)
             └── recurring_templates.user_id (ON DELETE RESTRICT)
```

**Borrado de usuario = soft delete.** Ninguna FK usa `ON DELETE CASCADE`. Dar de baja a un usuario es setear `profiles.deleted_at`; sus datos permanecen íntegros. Un `DELETE` físico sobre `profiles` es rechazado por las seis FKs en `RESTRICT`, lo cual es el comportamiento deseado: el ledger de un usuario no se destruye por una operación administrativa.

**Cómo se determina la propiedad de los datos:**

Consistente con §2, punto 7 del flujo de auth: el `userId` usado en cualquier query u operación **siempre** proviene del JWT decodificado por `AuthGuard`, nunca de un parámetro del body/query. En la capa de datos:

- Toda operación de escritura recibe el `userId` como parámetro explícito desde el `Service`.
- Toda operación de lectura filtra por `user_id` en el `Repository`. **No** se delega este filtro a RLS, porque Prisma corre como service role y bypassa RLS.
- Las funciones de §3.9 **exigen `p_user_id` como parámetro obligatorio**, precisamente para que ese filtro no pueda olvidarse.

**Consecuencia importante — `auth.uid()` es inerte en la ruta normal:**

Como documenta §3 y §9, Prisma se conecta con permisos de servicio. Dentro de una query de Prisma, `auth.uid()` devuelve `NULL` y **todas las policies RLS son transparentes**. Las policies de §3.8 solo se activan para conexiones que presentan un JWT de usuario, es decir, accesos que **no** pasan por el backend.

**Implicación operativa:** ninguna función ni trigger de esta capa puede depender de `auth.uid()`.

---

## 3.8 Políticas RLS

RLS se activa (`ENABLE ROW LEVEL SECURITY`) en las seis tablas, con el criterio de defensa en profundidad ya establecido en §3 y §9, y con el alcance precisado en RD2 (§3.1): **propiedad de filas, exclusivamente.**

**Patrón general para las seis tablas:**

| Operación | Condición | Rol |
|---|---|---|
| `SELECT` | `USING (user_id = auth.uid())` | `authenticated` |
| `INSERT` | `WITH CHECK (user_id = auth.uid())` | `authenticated` |
| `UPDATE` | `USING (user_id = auth.uid())` **y** `WITH CHECK (user_id = auth.uid())` | `authenticated` |
| `DELETE` | `USING (user_id = auth.uid())` | `authenticated` |

El doble `USING` + `WITH CHECK` en `UPDATE` es necesario: `USING` controla qué filas puede tocar, `WITH CHECK` impide que la fila resultante quede con un `user_id` de otro usuario.

**Ejemplo explícito (`accounts`, se replica igual en las otras cinco):**

```sql
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
```

**Caso especial — `entries`:**

`entries` tiene `user_id` desnormalizado precisamente para poder aplicar el mismo patrón directo, **sin JOIN a `transactions`**. Un policy con subquery se evalúa por fila y degrada el rendimiento de cualquier agregación. La consistencia de ese `user_id` está garantizada por R3. **Sin R3, la desnormalización sería un hueco de seguridad, no una optimización.**

**Rol `service_role`:** bypassa RLS por diseño de Postgres. Es la conexión que usa Prisma. No se crean policies para él.

### Estado de verificación de RLS

**RLS no está cubierta por tests.** La DB de integración es Postgres local vía Docker, que no trae nada de lo que Supabase agrega por encima del motor. Se decidió **no** emular ese contexto (ver §3.15, C1 resuelto, y §7).

**Stub local mínimo — lo que sí se provisiona, y por qué.** Aunque RLS no se testee, las migraciones que la declaran tienen que **aplicarse** contra el contenedor local, y eso exige que ciertos objetos existan o el `CREATE POLICY` falla. El stub (`test/setup/local-auth-stub.sql`, aplicado vía `globalSetup` de Jest) crea exactamente tres cosas, ninguna más:

| Objeto | Por qué es necesario |
|---|---|
| Schema `auth` + tabla `auth.users` (solo `id uuid primary key`) | La FK de `profiles.id` no resuelve sin ella |
| Función `auth.uid()` | Las policies no compilan sin ella; en local lee de una GUC de sesión |
| Rol `authenticated` | `CREATE POLICY ... TO authenticated` falla si el rol no existe. Supabase lo provisiona por proyecto; Postgres plano no lo trae |

**El stub vive fuera de las migraciones de Prisma, deliberadamente** (ver §7). Nunca se ejecuta contra Supabase real, donde estos tres objetos ya existen y son propiedad de Supabase. Versionar DDL sobre el schema `auth` en producción sería competir con un schema que no controlamos.

Que estos objetos existan en local **no** habilita tests de RLS: `auth.uid()` es un stub que lee una GUC, no GoTrue resolviendo un JWT real. Su única función es permitir que el DDL se aplique.

**Consecuencia asumida, explícita:** las policies se escriben y despliegan, pero **su corrección no está verificada automáticamente**. RLS es una capa secundaria; la garantía real de aislamiento entre usuarios son (a) el filtro por `user_id` en cada `Repository` y (b) el parámetro obligatorio `p_user_id` de las funciones de §3.9. Si una policy tuviera un error, no habría test que lo detecte. Se acepta este riesgo porque RLS solo se activa en rutas que hoy no existen (acceso directo desde cliente, Realtime, fuga de anon key).

---

## 3.9 Funciones de consulta derivada

**Decisión estructural: son funciones, no vistas.** Todas reciben `p_user_id uuid` como **parámetro obligatorio**.

**Racional:** Prisma corre como `service_role` y bypassa RLS. Una vista abierta consultada desde un `Repository` que olvide el `WHERE user_id = ...` devuelve datos de **todos** los usuarios, silenciosamente. Una función con parámetro obligatorio hace ese error imposible de cometer: no compila sin el argumento. Es una garantía estructural, no una convención que dependa de disciplina.

Todas se declaran `STABLE` y `SECURITY INVOKER` (el default), viven en migraciones SQL raw (RD1), y se consultan con `$queryRaw` tipado desde un `Repository` dedicado, respetando el patrón Repository de §1. Prisma no las tipa: los tipos de retorno se declaran manualmente junto al `Repository` que las consume.

### Filtrado: qué se excluye y qué no

La regla anterior ("filtran `deleted_at IS NULL` / `archived_at IS NULL` donde aplique") era ambigua y peligrosa justo aquí. Se reemplaza por una regla explícita y sin excepción.

**Archivar es una acción organizacional. Nunca mueve un peso.** Su único efecto es retirar la cuenta de las listas de selección.

| Consumidor | Cuentas con `archived_at` |
|---|---|
| **F1** `fn_account_balances` | **Incluidas.** Su saldo sigue siendo parte del patrimonio |
| **F2** `fn_category_balances` | **Incluidas.** Una categoría archivada a media quincena tuvo gasto real en ese periodo |
| **F3** `fn_unassigned_funds` | **Incluidas**, tanto en `dinero_real` como en `comprometido` |
| **F4** `fn_transactions_without_period` | **Incluidas** |
| Endpoints de listado/selección de cuentas | **Excluidas** — es el único lugar donde el filtro aplica |

**Por qué importa especialmente:** R8 permite archivar categorías de gasto con saldo acumulado (decisión deliberada, §3.4). Si F3 excluyera archivadas, archivar "Comida" con $50,000 de gasto histórico **cambiaría el dinero disponible del usuario solo por haber ordenado su lista**. Un cambio organizacional no puede alterar un número financiero.

**`deleted_at` sí filtra, siempre.** Los soft-deletes de `budget_periods` y `budget_entries` **se excluyen** de todos los cálculos: un presupuesto borrado no comprometió nada. La distinción es: `archived_at` en `accounts` **no** filtra en los cálculos; `deleted_at` en el resto de tablas **sí** filtra en todos.

---

**F1 — `fn_account_balances(p_user_id uuid)`**

Saldo actual de cada cuenta del usuario. Fuente de verdad de "cuánto tengo".

```sql
CREATE FUNCTION fn_account_balances(p_user_id uuid)
RETURNS TABLE (
  account_id uuid, name text, type account_type,
  currency char(3), balance_cents bigint
)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT a.id, a.name, a.type, a.currency,
         COALESCE(SUM(e.amount_cents), 0)::bigint
  FROM accounts a
  LEFT JOIN entries e ON e.account_id = a.id
  WHERE a.user_id = p_user_id
  GROUP BY a.id;
$$;
```

`LEFT JOIN` es obligatorio: una cuenta recién creada sin movimientos debe aparecer con saldo `0`, no desaparecer.

---

**F2 — `fn_category_balances(p_user_id uuid, p_period_id uuid)`**

Por categoría dentro de un periodo: asignado, gastado, disponible.

- **Asignado** = `SUM(budget_entries.amount_cents)` de ese periodo y categoría, con `deleted_at IS NULL`. Incluye tanto `manual` como `rollover`, porque el rollover ya está materializado como un entry real.
- **Gastado** = `SUM(entries.amount_cents)` de entries cuya cuenta es esa categoría y cuya transacción tiene `booked_at` dentro del rango del periodo.
- **Disponible** = asignado − gastado.

Como el rollover se **materializa** al cerrar (no se calcula recursivamente), esta función nunca recorre periodos anteriores. Ese es todo el punto de materializar.

**Estados derivados:**

| Condición | Estado que muestra la UI |
|---|---|
| Sin `budget_entries` vigentes para ese periodo/categoría | **"Sin presupuesto"** — no es disponible negativo |
| `disponible > 0` | Disponible |
| `disponible = 0` | Agotado |
| `disponible < 0` | **Sobregiro** — se muestra en negativo, con aviso y sugerencia de cobertura |

La función debe devolver una bandera (`has_budget boolean`) que distinga "sin presupuesto" de "disponible cero", porque ambos casos producen números similares y significan cosas distintas.

La sugerencia de cobertura de sobregiro es una consulta sobre el mismo resultado: categorías del periodo con `disponible > 0`, ordenadas descendente. No requiere tabla ni columna adicional.

**Firma exacta:**

```sql
CREATE FUNCTION fn_category_balances(p_user_id uuid, p_period_id uuid)
RETURNS TABLE (
  category_id      uuid,
  name             text,
  assigned_cents   bigint,
  spent_cents      bigint,
  available_cents  bigint,
  has_budget       boolean
)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  WITH period AS (
    SELECT bp.starts_on, bp.ends_on
    FROM budget_periods bp
    WHERE bp.id = p_period_id
      AND bp.user_id = p_user_id
      AND bp.deleted_at IS NULL
  ),
  assigned AS (
    SELECT be.category_id,
           SUM(be.amount_cents)::bigint AS cents,
           count(*)                     AS n
    FROM budget_entries be
    WHERE be.user_id = p_user_id
      AND be.period_id = p_period_id
      AND be.deleted_at IS NULL
    GROUP BY be.category_id
  ),
  spent AS (
    SELECT e.account_id AS category_id,
           SUM(e.amount_cents)::bigint AS cents
    FROM entries e
    JOIN transactions t ON t.id = e.transaction_id
    CROSS JOIN period p
    WHERE e.user_id = p_user_id
      AND t.booked_at BETWEEN p.starts_on AND p.ends_on
    GROUP BY e.account_id
  )
  SELECT a.id,
         a.name,
         COALESCE(asg.cents, 0)::bigint,
         COALESCE(sp.cents, 0)::bigint,
         (COALESCE(asg.cents, 0) - COALESCE(sp.cents, 0))::bigint,
         COALESCE(asg.n, 0) > 0
  FROM accounts a
  LEFT JOIN assigned asg ON asg.category_id = a.id
  LEFT JOIN spent    sp  ON sp.category_id  = a.id
  WHERE a.user_id = p_user_id
    AND a.type = 'expense';
$$;
```

**Notas normativas sobre la firma:**

- **Los tres montos son `bigint`**, nunca `numeric` ni `integer`. El `::bigint` explícito es obligatorio: `SUM()` sobre `bigint` devuelve `numeric` en Postgres, y sin el cast Prisma recibe un `Decimal` en vez de un `BigInt`.
- **`has_budget` se deriva del conteo de filas, no del monto.** `count(*) > 0` sobre `budget_entries` vigentes. Derivarlo de `assigned_cents <> 0` sería incorrecto: dos asignaciones que se cancelan (`+500` y `−500`) dan `assigned_cents = 0` pero **sí** hay presupuesto.
- **No filtra `archived_at`** (§3.9, tabla de filtrado). Una categoría archivada a media quincena sigue apareciendo con su gasto real del periodo.
- **`LEFT JOIN` desde `accounts`**, no desde `budget_entries`: una categoría sin asignación ni gasto debe aparecer con ceros y `has_budget = false`, no desaparecer.

---

**F3 — `fn_unassigned_funds(p_user_id uuid)`**

**Tercera y definitiva definición.** La versión original calculaba *ingresos del periodo − asignaciones del periodo*, e ignoraba el saldo real de las cuentas. La segunda corrigió eso pero introdujo agregación histórica global, incompatible con el rollover materializado. Esta versión conserva la base correcta (saldo real de cuentas), agrega **por categoría** y acota el universo a los **periodos no cerrados**.

**Por qué la fórmula histórica global estaba mal — dos fallos independientes:**

*Fallo A — el rollover se contaba dos veces.* Asignas $2,000 a Comida y gastas $500. Al cerrar, el rollover materializa +$1,500 en el periodo siguiente. El histórico pasa a sumar $3,500 asignados contra $500 gastados: el sobrante quedó contado dos veces, una en la asignación original y otra en el entry de rollover. Esto ocurría **siempre** que había rollover, no en casos raros.

*Fallo B — el sobregiro se convertía en dinero fantasma.* Restar `asignado − gastado` de forma agregada hace que una categoría en negativo **sume** en vez de restar.

**Causa raíz:** el rollover materializado, F2 y todo el ciclo de cierre son mecanismos que operan sobre periodos vivos. F3 era la única pieza que agregaba sobre todo el histórico. La incoherencia estaba en F3, no en el rollover.

**Definición vigente:**

```
sin_asignar(usuario) = dinero_real − comprometido
```

**`dinero_real`** — saldo de cuentas `asset` + saldo de cuentas `liability` (negativos, por lo que la deuda resta). **De todo el histórico, sin filtro de periodo:** es el dinero que existe hoy.

**`comprometido`** — agregación **por categoría**, sobre **todos los `budget_periods` del usuario con `closed_at IS NULL`** (y `deleted_at IS NULL`):

```sql
comprometido = SUM( GREATEST(disponible_cp, 0) )       -- sobrantes: dinero apartado
             + SUM( ABS(LEAST(disponible_cp, 0)) )     -- déficits: dinero que hay que cubrir
```

donde `disponible_cp = asignado_c(periodo p) − gastado_c(periodo p)` para cada par `(categoría, periodo abierto)`, exactamente el mismo `disponible` que calcula F2.

**Por qué se excluyen los periodos cerrados — es lo que evita el Fallo A.** Un periodo cerrado ya materializó su resultado: los sobrantes `accumulate` se convirtieron en un `budget_entry` de rollover dentro del periodo siguiente (donde sí se cuentan), los sobrantes `reset` se liberaron, y los déficits se arrastraron como entry negativo. Volver a agregarlos sería contar el mismo dinero dos veces. **El cierre es exactamente el acto de sacar un periodo del universo de `comprometido`.**

**Por qué no lleva `p_period_id`.** El compromiso del usuario no pertenece a un periodo en particular: si tiene dos periodos abiertos a la vez (típicamente uno vencido sin cerrar más el actual), el dinero apartado en ambos está igualmente comprometido. Acotar el cálculo al periodo consultado reportaría más dinero disponible del que realmente lo está, justo en el estado transitorio en que el usuario más consulta este número — le acaban de pagar y todavía no cierra el anterior.

> ### ⚠️ Advertencia al implementador
>
> **La agregación por categoría NO es equivalente a la resta agregada `SUM(asignado) − SUM(gastado)`.**
>
> Son idénticas mientras todas las categorías estén en positivo, y divergen en cuanto **una sola** queda en negativo. Esa divergencia *es* el Fallo B. "Simplificar" la fórmula a la resta global reintroduce el bug, y la suite de tests solo lo detecta si hay un caso con sobregiro. **No simplificar.**
>
> La agregación es por par `(categoría, periodo abierto)`, no por categoría colapsando periodos. Colapsarlos permitiría que un sobrante en un periodo compense un déficit en otro, que es otra vía al mismo Fallo B.

**Ejemplo canónico de verificación:**

> Cash $10,000, un solo periodo abierto. Asignas $2,000 a Comida, gastas $500 en Comida, gastas $300 en Salud sin presupuesto.
>
> - `dinero_real` = 10,000 − 500 − 300 = **$9,200**
> - `disponible_Comida` = 2,000 − 500 = **+$1,500**
> - `disponible_Salud` = 0 − 300 = **−$300**
> - `comprometido` = 1,500 + 300 = **$1,800**
> - **`sin_asignar` = 9,200 − 1,800 = $7,400** ✅
>
> Con la resta global rota: 9,200 − (2,000 − 800) = $8,000 ❌ — el mismo resultado que antes de gastar los $300 en Salud. El gasto no movió el número.

**Segundo ejemplo — dos periodos abiertos:**

> Mismo estado anterior, y además te pagan $5,000 y creas el periodo 2 sin cerrar el 1, asignando $1,000 a Comida en el nuevo.
>
> - `dinero_real` = 9,200 + 5,000 = **$14,200**
> - Periodo 1: `Comida +1,500`, `Salud −300` → 1,800
> - Periodo 2: `Comida +1,000` → 1,000
> - `comprometido` = **$2,800**
> - **`sin_asignar` = $11,400**
>
> Si el cálculo se acotara al periodo 2, daría $13,200 — $1,800 de dinero que en realidad sigue apartado en el periodo 1.

**Exclusiones por tipo de cuenta en `dinero_real`:**

| Tipo | ¿Cuenta? | Razón |
|---|---|---|
| `asset` | **Sí** | Es dinero disponible hoy |
| `liability` | **Sí** (resta) | La deuda de la tarjeta reduce lo que realmente puedes comprometer |
| `receivable` | **No** | Dinero que te deben. No lo puedes gastar ni presupuestar hoy. Sí cuenta para patrimonio neto (F1), no para asignación |
| `income` | **No** | Su saldo es un acumulado histórico, no un balance. El ingreso ya se refleja en el saldo de la cuenta `asset` que lo recibió; contarlo otra vez sería doble conteo |
| `expense` | **No** | Su acumulado ya está reflejado: el gasto redujo el saldo de la cuenta que lo pagó, y entra al cálculo vía `disponible_cp` |
| `equity` | **No** | El saldo inicial no es dinero adicional; su contrapartida ya está en los saldos de las cuentas reales |

**Racional de esta definición:**

1. **Usa el saldo real de las cuentas como base**, no los ingresos del periodo. Ese era el defecto de la versión original: ignoraba el dinero que ya tenías antes del periodo.
2. **Agrega por categoría**, no por resta global. Un déficit resta dinero disponible, no lo suma (Fallo B).
3. **Se acota a periodos abiertos.** Es la condición para no chocar con el rollover materializado (Fallo A) y lo que mantiene a F3 coherente con F2 y con §3.10.
4. **Se autocorrige:** capturar un gasto atrasado baja el número solo, porque `dinero_real` sale del ledger.

**Consecuencia a tener presente — periodos vencidos sin cerrar:**

Un periodo pasado que se quedó abierto sigue reteniendo su dinero comprometido, y ese dinero **no se libera hasta que se cierre**. Es el comportamiento correcto: el cierre es el mecanismo que decide si el sobrante se arrastra (`accumulate`) o se libera (`reset`). Pero refuerza por qué la app debe insistir activamente en cerrar periodos vencidos: mientras no se cierren, el usuario ve menos dinero disponible del que realmente podría asignar.

**Firma exacta:**

```sql
CREATE FUNCTION fn_unassigned_funds(p_user_id uuid)
RETURNS TABLE (
  unassigned_cents bigint
)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  WITH cash AS (
    SELECT COALESCE(SUM(e.amount_cents), 0)::bigint AS cents
    FROM entries e
    JOIN accounts a ON a.id = e.account_id
    WHERE e.user_id = p_user_id
      AND a.type IN ('asset', 'liability')
  ),
  open_periods AS (
    SELECT bp.id, bp.starts_on, bp.ends_on
    FROM budget_periods bp
    WHERE bp.user_id = p_user_id
      AND bp.closed_at  IS NULL
      AND bp.deleted_at IS NULL
  ),
  pair AS (
    SELECT
      COALESCE((
        SELECT SUM(be.amount_cents)
        FROM budget_entries be
        WHERE be.period_id   = op.id
          AND be.category_id = c.id
          AND be.deleted_at IS NULL
      ), 0)
      -
      COALESCE((
        SELECT SUM(e.amount_cents)
        FROM entries e
        JOIN transactions t ON t.id = e.transaction_id
        WHERE e.account_id = c.id
          AND t.booked_at BETWEEN op.starts_on AND op.ends_on
      ), 0) AS available
    FROM accounts c
    CROSS JOIN open_periods op
    WHERE c.user_id = p_user_id
      AND c.type = 'expense'
  )
  SELECT (
    cash.cents
    - COALESCE((
        SELECT SUM( GREATEST(p.available, 0) + ABS(LEAST(p.available, 0)) )
        FROM pair p
      ), 0)
  )::bigint
  FROM cash;
$$;
```

**Notas normativas sobre la firma:**

- **Devuelve exactamente una fila, siempre.** El `FROM cash` lo garantiza: `cash` es una agregación sin `GROUP BY`, así que produce una fila incluso sin ningún entry. Un usuario recién creado obtiene `unassigned_cents = 0`, no cero filas. Los consumidores pueden asumir una fila sin manejar el caso vacío.
- **`::bigint` obligatorio** por la misma razón que en F2: `SUM()` sobre `bigint` devuelve `numeric`.
- **La agregación es por par `(categoría, periodo abierto)`** — el `CROSS JOIN` entre categorías y periodos abiertos es lo que materializa esos pares. Colapsarlos es una de las tres formas de romper la función.
- **Simplificación permitida, y solo esta:** `GREATEST(x,0) + ABS(LEAST(x,0))` es algebraicamente idéntico a `ABS(x)`, así que `SUM(ABS(p.available))` es correcto y equivalente. Se conserva la forma larga en el documento porque hace explícito *por qué* sobrantes y déficits suman en la misma dirección. **Esta equivalencia no tiene nada que ver con la simplificación prohibida**, que es colapsar la agregación por par en `SUM(asignado) − SUM(gastado)`. La permitida opera dentro de cada par; la prohibida los colapsa.
- **`cash` no filtra `archived_at`** (§3.9, tabla de filtrado) y excluye `receivable`, `income`, `expense` y `equity` vía el `IN ('asset','liability')`.

---

---

**F4 — `fn_transactions_without_period(p_user_id uuid)`**

Transacciones cuyo `booked_at` no cae dentro de ningún `budget_period` vigente del usuario. Alimenta la lista de "pendientes de asignar" (§3.10).

Con huecos entre periodos permitidos, esta función es el mecanismo **único y suficiente** para detectar transacciones fuera de presupuesto. Reemplaza por completo a la regla de "sin huecos" que se eliminó.

**Firma exacta:**

```sql
CREATE FUNCTION fn_transactions_without_period(p_user_id uuid)
RETURNS TABLE (
  transaction_id uuid,
  booked_at      date,
  description    text
)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT t.id, t.booked_at, t.description
  FROM transactions t
  WHERE t.user_id = p_user_id
    AND NOT EXISTS (
      SELECT 1
      FROM budget_periods bp
      WHERE bp.user_id = p_user_id
        AND bp.deleted_at IS NULL
        AND t.booked_at BETWEEN bp.starts_on AND bp.ends_on
    )
  ORDER BY t.booked_at DESC;
$$;
```

**Notas normativas sobre la firma:**

- **`booked_at` es `date`**, no `timestamptz` (§3.6). El tipo de retorno debe coincidir con el de la columna.
- **`NOT EXISTS` ignora `closed_at`.** Una transacción dentro de un periodo cerrado **sí** tiene periodo y por lo tanto **no** aparece aquí. Esta función responde "¿esta fecha cae en algún periodo?", no "¿cae en un periodo abierto?". Filtrar por `closed_at` la convertiría en otra cosa.
- **Sí filtra `deleted_at`** en `budget_periods`: un periodo borrado no cubre ninguna fecha.
- **`description` se incluye** para que la lista de "pendientes de asignar" sea utilizable sin una segunda query por fila.

---

## 3.10 Ciclo de vida del periodo presupuestal

**Creación (manual, disparada por el usuario):**
No hay job automático. Al entrar a la app, si no existe un periodo abierto que cubra la fecha de hoy (calculada con `profiles.timezone`), la app propone crear uno. La creación siempre es una acción explícita. **Se permite dejar huecos.**

**Asignación de una transacción a un periodo:**
El usuario **nunca elige el periodo**. Se deriva de `booked_at`: el periodo vigente cuyo rango `[starts_on, ends_on]` contiene esa fecha. Como los periodos no se traslapan, la resolución es determinista. Si ninguno lo contiene, la transacción existe igual y aparece en F4.

**Cierre (manual, con aviso):**
Al entrar a la app, si existe un periodo con `ends_on` ya pasado y `closed_at IS NULL`, la app avisa y muestra el resumen por categoría. El usuario confirma. Al cerrar, en una sola transacción de base de datos:

1. Se resuelve **el periodo siguiente** según la definición de §3.3 (el `starts_on` más pequeño estrictamente mayor al `ends_on` del que se cierra).
2. Para cada categoría con `rollover_type = 'accumulate'` y `disponible > 0`: se inserta un `budget_entry` en el periodo siguiente con `source='rollover'`, `amount_cents` = disponible, y una `note` que identifique el origen.
3. **Para cada categoría con `disponible < 0` (sobregiro), sin importar su `rollover_type`:** se inserta un `budget_entry` **negativo** en el periodo siguiente con `source='rollover'`, por el monto del sobregiro. El déficit se arrastra.
4. Para cada categoría con `rollover_type = 'reset'` y `disponible > 0`: no se inserta nada. El sobrante deja de estar comprometido: como F3 es por periodo, ese dinero simplemente no aparece como `comprometido` en el periodo siguiente y queda disponible para asignar ahí.
5. Se setea `closed_at = now()` en el periodo cerrado.

**Por qué el sobregiro se arrastra incluso en categorías `reset`:** `reset` significa "el sobrante no se acumula", no "la deuda se perdona". Absorber el déficit silenciosamente haría que el dinero disponible del usuario no cuadre con la realidad: ese dinero ya se gastó. Arrastrarlo obliga a cubrirlo en el periodo siguiente, que es el comportamiento honesto.

**Precondiciones del cierre (validadas en el Service, antes de tocar la base):**

1. **El periodo siguiente debe existir.** El rollover se materializa contra él.
2. **El periodo siguiente debe estar abierto** (`closed_at IS NULL`).

**Por qué la segunda precondición.** Los cierres son manuales y pueden hacerse en cualquier orden. Si el usuario cierra el periodo 2 y después intenta cerrar el 1, el insert del rollover en el periodo 2 lo bloquea **R11**, y el cierre truena con un error de trigger crudo, sin explicación útil. Con la precondición, se rechaza antes con una **excepción de negocio tipada** (`ClosedPeriodException`) y un mensaje accionable: *"cierra primero el periodo anterior, o reabre el periodo siguiente"*.

**R11 se queda sin excepciones.** Abrirle un hueco para permitir los inserts de rollover sobre periodos cerrados debilitaría la única garantía que protege el presupuesto de un periodo cerrado, y el escenario de cierre desordenado es raro. Se prefiere rechazar con un mensaje claro antes que relajar el invariante.

**Ligado al PENDIENTE de reapertura (§3.14, punto 2):** mientras ese algoritmo no exista, un cierre desordenado es un **callejón sin salida** — el usuario no puede cerrar el periodo 1 ni reabrir el 2 de forma segura. La app debe evitar activamente que el usuario llegue a ese estado: presentar los cierres pendientes en orden cronológico y no ofrecer cerrar un periodo si existe otro anterior sin cerrar.

**PENDIENTE:** qué hacer si el usuario intenta cerrar sin que exista un periodo siguiente — ver §3.14.

**Doble materialización, imposible por diseño:** el índice único parcial sobre `(period_id, category_id) WHERE source='rollover' AND deleted_at IS NULL` impide que un cierre ejecutado dos veces duplique el arrastre.

**Transacción con `booked_at` en un periodo cerrado o inexistente:**

Regla de fondo, **inviolable**: el ledger de dinero nunca rechaza una transacción. El saldo de la cuenta se afecta **siempre**, sin importar la fecha ni el estado del periodo. Solo la capa de presupuesto queda pendiente de resolver.

| Situación | Comportamiento |
|---|---|
| El periodo existe y está abierto | Se asigna normal, sin aviso |
| El periodo existe pero está cerrado | La transacción se guarda. La app avisa y ofrece: **(default)** aplicar el impacto presupuestal al periodo actual, o reabrir el periodo cerrado |
| No hay periodo que cubra esa fecha (hueco, o antes del primer periodo) | La transacción se guarda. Aparece en `fn_transactions_without_period` |

**Racional del default:** la mayoría de los gastos atrasados son de monto bajo. Reabrir implica recalcular y re-materializar el rollover ya propagado, lo cual es costoso y arriesgado.

**PENDIENTE — mecánica de reapertura:** el algoritmo exacto de recálculo y re-materialización en cadena no se definió. Ver §3.14.

---

## 3.11 Manejo de dinero en la aplicación

**Representación:** `bigint` en Postgres, `BigInt` en Prisma/TypeScript. Siempre centavos. **Nunca** `float`, **nunca** `Decimal`.

1. La validación de suma-cero debe ser exacta. Con decimales queda la duda del redondeo acumulado.
2. `Decimal` de Prisma tampoco serializa limpio a JSON (devuelve objetos `Decimal.js`), así que no evita el trabajo de serialización, solo lo cambia de forma.
3. Es el estándar del dominio: Stripe y los sistemas bancarios manejan enteros.

**Serialización:** `BigInt` no es serializable nativamente a JSON. Se resuelve **en la primera línea del bootstrap**, antes de instanciar cualquier filtro o provider:

```ts
BigInt.prototype.toJSON = function () { return this.toString(); };
```

El orden importa: si el override se registra después del `GlobalExceptionFilter`, un error temprano que arrastre montos revienta al serializarse (ver §4).

La API entrega los montos como **string de centavos**, no como número — un `number` de JavaScript pierde precisión arriba de 2^53.

**Regla dura:** el monto **nunca sale de centavos** hasta el momento exacto de pintarlo. La división entre 100 vive en un único helper `formatMoney(cents)` del front. Ningún `Service`, `Repository`, DTO ni tool del MCP opera con unidades.

**Splits y redondeo:** al dividir un monto entre N partes, la suma de las partes debe ser exactamente el total. El residuo de la división entera se asigna a una de las partes (típicamente la primera), nunca se descarta. Si se descarta, la transacción no suma cero y R1 la rechaza.

---

## 3.12 Seeds al crear un usuario

Al crearse un `profile`, se siembra únicamente la infraestructura que ningún usuario puede crear por su cuenta. **Los seeds viven en una migración/función versionada (RD1)**, no en un script suelto.

**Cuenta de sistema:** Saldo Inicial (`type='equity'`, `is_system=true`). Es infraestructura, no contenido: sin ella `POST /transactions/opening-balances` no puede funcionar, y el usuario no puede crearla por su cuenta — `equity` no es un `kind` direccionable desde la API (§5.6 de `TASK-api.md`) y un `accountId` con `is_system=true` se rechaza con `403`.

**Las 7 categorías (`type='expense'`) y la fuente de ingreso Sueldo (`type='income'`) NO se siembran automáticamente.** Son opinión, no infraestructura: un usuario que no usa "Transporte" no debería encontrárselo el primer día. Pasan a ser una **lista sugerida que presenta el frontend durante el onboarding**, con checkboxes preseleccionados, creada con los endpoints normales (`POST /categories`, `POST /income-sources`):

| Nombre sugerido | `rollover_type` sugerido | Racional |
|---|---|---|
| Comida | `reset` | Gasto variable recurrente; acumular un sobrante de antojos no aporta |
| Transporte | `reset` | Igual que comida |
| Servicios | `accumulate` | Recibos que llegan en fechas irregulares; el sobrante debe esperar al recibo |
| Hogar | `reset` | Gasto corriente |
| Salud | `accumulate` | Gasto esporádico y potencialmente grande; acumular es el comportamiento correcto |
| Personal | `reset` | Gasto discrecional |
| Ahorro | `accumulate` | Por definición acumula |
| Sueldo | — (`income`) | Fuente de ingreso sugerida |

**NO se siembran cuentas reales** (banco, efectivo, tarjeta, ni cuentas `receivable`): dependen de cada usuario y se crean durante el onboarding.

**Consecuencia:** un usuario recién creado tiene la cuenta de sistema, pero **cero categorías, cero fuentes de ingreso, cero cuentas donde poner dinero**. El onboarding debe crear al menos una cuenta `asset` y presentar las sugerencias de la tabla de arriba antes de que sea posible registrar cualquier transacción.

**Punto de invocación (P-07, resuelto):** `EnsureProfileExistsService.ensure()`, en la misma transacción que el upsert de `profiles`, y solo cuando esa llamada de verdad insertó la fila — nunca en la rama "ya existía" del upsert. Se distingue vía `(xmax = 0) AS inserted` en el `RETURNING`, el idioma estándar de Postgres para saber si una fila devuelta por `INSERT ... ON CONFLICT DO UPDATE` vino de la rama INSERT o de la UPDATE dentro del mismo query. La atomicidad es deliberada: un perfil sin cuenta de sistema es un estado roto, y separar las dos escrituras abriría una ventana donde eso ocurre.

*(Una versión previa de este documento sembraba también las 7 categorías y "Sueldo". La decisión se revisó al verificar contra Supabase real: además de ser contenido opinado, el hallazgo destapó que **nada en `src/` invocaba la función de seed** — así que la cuenta de sistema tampoco se creaba y `POST /transactions/opening-balances` fallaba con un `TypeError` para cualquier usuario real. Ningún test lo detectó porque el fixture de pruebas inserta sus cuentas directo por SQL sin pasar por la función.)*

**Orden de arranque del usuario** (implementación en el front, fuera de alcance de la tarea de datos):

1. *(automático)* Seed: cuenta de sistema (Saldo Inicial).
2. Crear cuentas reales (`asset` / `liability`) — primero el "dónde tengo mi dinero".
3. Registrar la transacción de saldo inicial: un entry por cada cuenta real con su saldo actual, más el entry de cuadre contra la cuenta `equity`.
4. Onboarding de categorías: presentar las sugeridas y crear las que el usuario elija (`POST /categories`, `POST /income-sources`).
5. Crear el primer `budget_period`.
6. Asignar presupuesto (`budget_entries`).

---

## 3.13 Tabla de decisiones — capa de datos

| Decisión | Razón | Alternativa descartada | Qué se rompería si cambiamos esto después |
|---|---|---|---|
| **Partida doble (entries que suman cero)** | Elimina todos los casos especiales: gasto, transferencia, pago de TDC, préstamo y cuenta dividida son mecánicamente idénticos | `transactions` con `from_account`, `to_account`, `category_id` y un `type` discriminador | Reescritura total del modelo. Toda transacción con más de 2 entries deja de ser representable |
| **Saldos derivados, nunca almacenados** | Fuente única de verdad | Columna `balance` en `accounts` | Introducirla después obliga a backfill y a mantener sincronía para siempre; cualquier hueco produce diferencias silenciosas |
| **Categorías = cuentas `type='expense'`** | Un entry apunta a una categoría con el mismo mecanismo que a una cuenta bancaria | Tabla `categories` separada | Separarlas después obliga a migrar todos los entries de gasto y duplicar la lógica de saldos y RLS |
| **`receivable` como valor del enum, no como subtipo** | La distinción afecta cálculos (F3 lo excluye, F1 lo incluye), no solo presentación | Columna `subtype` en `accounts`, o tratarlo como `asset` | Tratarlo como `asset` infla el dinero asignable con dinero que no tienes. Migrar después obliga a reclasificar cuentas existentes a mano |
| **Dinero en `BigInt` de centavos** | Suma-cero exacta; estándar del dominio | `Decimal(14,2)` o `float` | Migrar desde `float` implica aceptar que los datos históricos ya tienen error |
| **Ledger inmutable, reversa como único camino de corrección** | Historial auditable y reportes reproducibles | Edición directa, o ventana de gracia para borrado duro | Permitir edición invalida cualquier reporte histórico ya generado y hace irreproducibles los rollovers materializados |
| **`transactions` y `entries` exentas del soft delete** | Un `deleted_at` en `entries` rompe la suma-cero: excluir entries "borrados" desbalancea la transacción | `deleted_at` uniforme en todas las tablas | Agregarlo obliga a decidir si las agregaciones lo respetan; ambas respuestas son incorrectas |
| **Soft delete en el resto de tablas + `ON DELETE RESTRICT` hacia `profiles`** | Dar de baja un usuario no debe destruir su ledger | `ON DELETE CASCADE` desde `profiles` | Con CASCADE, un borrado administrativo destruye datos financieros de forma irreversible |
| **Dos ledgers separados (dinero vs presupuesto)** | El ledger de dinero nunca se bloquea; permite gastos atrasados sin corromper saldos | Un solo ledger con el presupuesto como columna | Fusionarlos obliga a que la captura de un gasto atrasado falle o mienta sobre el saldo |
| **`booked_at` como `date`, no `timestamptz`** | Un gasto de las 23:00 en CDMX se agruparía en la quincena equivocada | `timestamptz` para ambos campos | Cambiarlo reasigna retroactivamente transacciones cerca de cada límite de periodo, alterando reportes cerrados |
| **`profiles.timezone` para "hoy", pero `booked_at` sigue siendo `date`** | Un usuario que cambia de zona no debe ver sus gastos pasados reasignados | Derivar `booked_at` de `created_at` + timezone | Recalcular fechas históricas al cambiar de zona altera reportes ya cerrados |
| **Huecos entre periodos permitidos; sin regla de continuidad** | `fn_transactions_without_period` ya cubre el escenario; una regla extra solo agrega fricción | Validar continuidad en el Service (la antigua R9) | Reintroducir la regla rompe a cualquier usuario que ya tenga huecos y bloquea la creación de periodos legítimos |
| **Rollover materializado como `budget_entry`** | Historial auditable por periodo; evita recorrer N periodos anteriores | Calcularlo recursivamente al vuelo | Cambiar a cálculo al vuelo obliga a purgar los entries `source='rollover'` o se cuentan dos veces |
| **Sobregiro se arrastra, incluso en categorías `reset`** | `reset` significa "el sobrante no se acumula", no "la deuda se perdona" | Absorber el déficit al cerrar | Absorberlo hace que el dinero disponible no cuadre con la realidad: ya se gastó |
| **Cierre de periodo manual, no por job** | El usuario revisa y confirma los sobrantes antes de propagarlos | Job automático al final de cada periodo | Automatizarlo requiere decidir qué hacer con periodos vencidos acumulados |
| **Fechas de periodo como datos, no reglas** | Soporta quincenas fijas (1–15) y variables (2–16) sin cambiar schema | Derivarlas de una regla (`day_of_month`) | Pasar a regla fija rompe a cualquier usuario cuya fecha de pago no coincida |
| **Fechas bloqueadas al cerrar (R10) y `budget_entries` bloqueados (R11)** | Un periodo cerrado ya propagó su rollover; modificarlo después lo deja sin correspondencia | Permitir edición libre, validando solo en el Service | Sin el trigger, un fix manual corrompe el rollover propagado en silencio |
| **"Sin asignar" = dinero real − comprometido, agregado por `(categoría, periodo abierto)`** | El saldo real de las cuentas como base corrige el defecto de "ingresos del periodo"; excluir periodos cerrados evita chocar con el rollover materializado | (a) Fórmula por periodo basada en ingresos; (b) agregación histórica global `cash − (asignado_total − gastado_total)` | Volver a global reintroduce el doble conteo del rollover (Fallo A). Sustituir la agregación por categoría por una resta global reintroduce el dinero fantasma del sobregiro (Fallo B), y solo se detecta si hay un test con categoría en negativo |
| **`comprometido` agrega `GREATEST(disponible,0) + ABS(LEAST(disponible,0))` por par (categoría, periodo abierto)** | Un déficit debe *restar* dinero disponible, no sumarlo. La resta global hace lo contrario, y colapsar periodos deja que un sobrante compense un déficit ajeno | `SUM(asignado) − SUM(gastado)`, o agregar por categoría colapsando periodos | Es la "simplificación" que parece equivalente y no lo es: divergen en cuanto una sola categoría queda negativa |
| **F3 agrega TODOS los periodos no cerrados, y no recibe `p_period_id`** | El compromiso no pertenece a un periodo: con dos periodos abiertos (uno vencido + el actual), el dinero apartado en ambos sigue igualmente comprometido | Acotar el cálculo al periodo consultado, con firma `(p_user_id, p_period_id)` | Acotarlo reporta dinero disponible de más justo en el estado transitorio en que el usuario más consulta el número — le acaban de pagar y no ha cerrado el anterior |
| **El cierre de periodo es lo que saca un periodo de `comprometido`** | Un periodo cerrado ya materializó su resultado: `accumulate` como rollover en el siguiente, `reset` liberado, déficit arrastrado. Reagregarlo sería contarlo dos veces | Incluir periodos cerrados en el universo de F3 | Incluirlos reintroduce el Fallo A de forma directa: cada rollover se cuenta en su periodo origen y en el destino |
| **Cuentas archivadas SÍ cuentan en F1–F4; solo se excluyen de listados de selección** | Archivar es organizacional y nunca mueve un peso. Como R8 permite archivar categorías con saldo acumulado, excluirlas cambiaría el dinero disponible del usuario solo por ordenar su lista | Filtrar `archived_at IS NULL` en los cálculos, como se hace con `deleted_at` | Excluirlas hace que una acción de orden altere números financieros; el usuario ve su dinero cambiar sin haber gastado nada |
| **Cerrar exige que el periodo siguiente exista Y esté abierto** | Sin la precondición, un cierre desordenado choca contra R11 y truena con un error de trigger crudo, sin explicación | Abrirle una excepción a R11 para los inserts de rollover | La excepción a R11 debilita la única garantía que protege el presupuesto de un periodo cerrado; cualquier fix manual podría corromper el rollover propagado |
| **R9 con dos puntos de disparo (`entries` + `transactions`)** | Una reversa con cero entries se salta el trigger sobre `entries`, consume el índice único de reversa e impide crear la reversa real | Solo el trigger diferido sobre `entries` | Quitar el disparo sobre `transactions` reabre el hueco: la transacción original queda permanentemente sin poder revertirse |
| **`transaction` + `entries` siempre en la misma transacción de DB (regla de Service)** | La base no puede garantizarlo: los triggers viven sobre `entries` y una transacción vacía nunca los dispara | Crear la transacción primero y los entries en una llamada posterior | Una transacción huérfana con `idempotency_key` quema la llave: el reintento legítimo devuelve un registro vacío y el usuario ve su gasto como registrado sin que exista |
| **Funciones con `p_user_id` obligatorio, no vistas** | Prisma bypassa RLS; una vista abierta devuelve datos de todos si el Repository olvida el filtro | Vistas con `security_invoker = true` | `security_invoker` no protege a `service_role`, que es justo la conexión de Prisma. Volver a vistas reintroduce el riesgo de fuga entre usuarios |
| **`user_id` desnormalizado en `entries`** | Policies RLS sin subquery/JOIN; acelera agregaciones | Derivarlo vía JOIN a `transactions` | Quitarlo degrada RLS y reportes. Mantenerlo exige R3 para siempre |
| **Triggers de integridad en migraciones SQL raw (RD1)** | Protegen contra escrituras que no pasan por el Service | Confiar solo en el Service | Sin ellos, el invariante de suma-cero no tiene garantía física |
| **`ERRCODE` distinguible por regla** | El Service mapea cada violación a su excepción tipada sin parsear texto | Un único `ERRCODE` genérico | Sin códigos, el mapeo depende del texto del mensaje, que se rompe al traducirlo o editarlo |
| **`updated_at` gestionado por Prisma, sin trigger** | Un solo lugar; el flujo normal siempre pasa por Prisma | Trigger `BEFORE UPDATE` | Escrituras manuales o de migración no actualizan el campo; no es confiable para sync ni cache |
| **Idempotencia con `ON CONFLICT DO NOTHING` + re-select** | Una violación de unicidad aborta la transacción completa en Postgres; el catch-and-select no es implementable | `INSERT` + capturar `23505` + `SELECT` en la misma transacción | El re-select falla con `25P02`; el request devuelve 500 en vez de la transacción existente |
| **`idempotency_key` nullable** | Escrituras internas no necesitan key; el índice parcial permite múltiples `NULL` | `NOT NULL` desde el día uno | Hacerla obligatoria después requiere backfill y coordinar front y MCP simultáneamente |
| **R8 solo para `asset`, `receivable` y `liability`** | El saldo de `expense`/`income` es un acumulado que nunca vuelve a cero; la regla las volvería inarchivables | Aplicar R8 a todos los tipos | Aplicarla a todos deja categorías imposibles de retirar de la lista |
| **R2 permite 0 entries, prohíbe exactamente 1** | Una transacción vacía es inerte; una de un entry es imposible de balancear | Exigir siempre ≥2 | Exigirlo obliga a un orden de inserción rígido sin ganar garantía contable |
| **R9 valida magnitud, no equivalencia cuenta por cuenta** | Una reversa puede necesitar rutear por cuentas distintas (reembolso a otra cuenta) | Exigir simetría exacta de entries | La simetría exacta bloquea correcciones legítimas |
| **`ON DELETE RESTRICT` en `entries.account_id`** | Una cuenta con movimientos se archiva, no se borra | `ON DELETE CASCADE` | Con CASCADE, borrar una cuenta por error desbalancea transacciones de forma irreversible |
| **`EXCLUDE` de no-traslape con predicado `deleted_at IS NULL`** | Sin el predicado, un periodo borrado bloquea la creación de uno nuevo en el mismo rango | `EXCLUDE` sin predicado, o validación en Service | Sin el constraint, un traslape hace que una transacción caiga en dos periodos |
| **RLS sin cobertura de tests** | Emular el contexto de Supabase en Docker contradice el aislamiento de §7 | Instancia de Supabase dedicada a testing | Se asume el riesgo: un error en una policy no sería detectado. Mitigado por el filtro del Repository y `p_user_id` obligatorio |
| **Seeds de categorías al crear usuario, sin cuentas reales** | El usuario opera desde el primer minuto sin ensuciar la lista con cuentas que no usa | Sembrar también "Efectivo" y "Banco" genéricos | Sembrar cuentas reales genéricas obliga al usuario a borrarlas o convivir con cuentas muertas |

---

## 3.14 PENDIENTE — no cerrado

Lo siguiente **no se decidió** y no debe resolverse por criterio propio de un agente.

**Bloquean funcionalidad (no la migración inicial):**

1. **Cierre sin periodo siguiente.** El rollover se materializa contra el periodo siguiente. Falta decidir si el cierre se bloquea con un mensaje, si crea el periodo, o si el rollover queda diferido hasta que exista.
2. **Algoritmo de reapertura de un periodo cerrado.** Se decidió que es una opción del usuario; no se definió cómo se revierte y re-materializa el rollover ya propagado en cadena, ni qué pasa con los periodos posteriores ya cerrados.
3. **Categoría "Pérdidas" para préstamos incobrables.** El mecanismo contable está formalizado (§3.2), pero no se decidió si la categoría se siembra automáticamente, se crea al primer uso, o la crea el usuario.
4. **Ventana de visibilidad en la carrera de idempotencia.** Cuando `ON CONFLICT DO NOTHING` detecta el conflicto pero la transacción original aún no ha hecho `COMMIT`, la fila existe y no es visible. Falta decidir entre reintento corto de lectura o responder `409`.

**Coordinación con `TASK-auth` (columnas en `profiles`, tabla que no es de esta capa):**

5. **`profiles.timezone`** — decidido que se implementa (§3.6), falta acordar en qué tarea se agrega la columna y su default.
6. **`profiles.deleted_at`** — decidido que el borrado de usuario es soft delete (§3.3), falta acordar dónde se agrega la columna.
7. ~~**Garantía de creación de `profiles`.**~~ **RESUELTO.** Mecanismo: creación explícita y lazy en `EnsureProfileExistsService.ensure()` (`TASK-auth`). Punto de invocación de los seeds: la misma llamada, misma transacción, solo en la rama de inserción del upsert — ver §3.12.

**Diferidos explícitamente (fuera de alcance de esta fase):**

8. **Multi-moneda.** Puerta abierta: se agregarían `exchange_rate` y `amount_base_cents` a `entries`. `accounts.currency` ya existe y R4 ya impide mezclar monedas.
9. **Tools del MCP.** Definición de qué recibe cada tool y cómo resuelve ambigüedad (ej. "gasté 200 en comida" sin especificar cuenta).
10. **Tests de `Service`** de esta capa — dependen de que existan los services.
11. **Cache.** Aplica lo documentado en §3: el patrón Repository lo aísla.

**Cerrados desde la versión anterior de este documento** (ya no son pendientes): `idempotency_key` nullable (§3.5); FK apuntando a `profiles.id` (§3.7); excepción del cascade en R5 — eliminada al pasar todo a `RESTRICT` (§3.4); sobregiro al cerrar — se arrastra (§3.10); distinción de cuentas por cobrar — enum `receivable` (§3.2); préstamo incobrable — formalizado (§3.2); `onboarding_completed_at` — fuera de alcance, se maneja en UX; `profiles.timezone` — se implementa (§3.6); seeds — definidos (§3.12).

---

## 3.15 Conflictos entre capas — estado

Los cinco conflictos detectados en la auditoría fueron resueltos o reclasificados. Se conserva el registro por trazabilidad.

**C1 — Tests de RLS no ejecutables en Postgres local — ✅ RESUELTO**

- **Era:** los tests de RLS exigían `auth.uid()`, roles `anon`/`authenticated` y JWTs de Supabase, que no existen en un contenedor de Postgres plano.
- **Resolución:** **se eliminan los tests de RLS del alcance.** La DB de test sigue siendo Postgres local vía Docker, sin emular el contexto de Supabase. Ver §7 y §3.8.
- **Consecuencia asumida:** RLS queda como capa desplegada pero **no verificada por tests**. El aislamiento real entre usuarios lo garantizan el filtro por `user_id` del `Repository` y el parámetro obligatorio `p_user_id` de las funciones de §3.9.

**C2 — Objetos creados en la UI de Supabase no llegan a la DB de tests — ✅ RECLASIFICADO A REGLA DURA**

- **Era:** un trigger creado desde Supabase existiría en producción pero no en el contenedor de tests.
- **Resolución:** deja de ser conflicto y pasa a ser **RD1** (§3.1): todo objeto de base de datos vive en una migración versionada de Prisma; `prisma db push` prohibido. Prototipar en la UI es aceptable; dejarlo ahí no.

**C3 — "RLS espejo de la autorización en código" no aplica a los invariantes contables — ✅ RECLASIFICADO A PRECISIÓN DE ALCANCE**

- **Era:** §3 pide que las policies reflejen las reglas de autorización del código, pero una policy no puede validar suma-cero ni agregaciones sobre filas hermanas.
- **Resolución:** deja de ser conflicto y pasa a ser **RD2** (§3.1): RLS cubre exclusivamente propiedad de filas; los invariantes contables viven en los triggers de §3.4. No modifica §3; lo precisa.

**C4 — `GlobalExceptionFilter` puede reventar al serializar `BigInt` — ✅ RESUELTO**

- **Era:** si el filtro serializa un contexto con montos `BigInt` antes de que exista el override de `toJSON`, lanza `TypeError` dentro del manejador de errores.
- **Resolución (dos capas, documentada en §4):** (1) el override se registra en la **primera línea del bootstrap**, antes de instanciar el filtro; (2) la escritura a `ErrorLog` usa un **serializador defensivo** que reemplaza cualquier valor no serializable por un string legible en vez de lanzar. Consistente con el principio best-effort ya documentado en §4.

**C5 — `ON DELETE CASCADE` desde `profiles` colisiona con la inmutabilidad del ledger — ✅ RESUELTO**

- **Era:** borrar un usuario disparaba el cascade sobre `entries`, que R5 bloqueaba; el borrado fallaba con error de trigger.
- **Resolución:** **el borrado de usuario es soft delete.** Todas las FKs hacia `profiles.id` pasan de `ON DELETE CASCADE` a `ON DELETE RESTRICT` (§3.3, §3.7). No existe ninguna vía legítima de borrado en cascada sobre el ledger, por lo que **R5 ya no necesita excepciones** y la regla queda sin casos especiales. Un `DELETE` físico sobre `profiles` es rechazado por las seis FKs, que es el comportamiento deseado.

**Conflictos abiertos: ninguno.**

---

## 4. Manejo de errores y logging

- **Excepciones tipadas:** `HttpException` y subclases de Nest; excepciones de negocio propias (ej. `InsufficientStockException extends BadRequestException`) para diferenciar error esperado de error inesperado.
- **`GlobalExceptionFilter` único:** captura toda excepción no manejada, responde con formato consistente (`statusCode`, `message`, `timestamp`, `path`), nunca expone stack trace ni mensajes crudos de Prisma/librerías al cliente.
- **`ErrorLog` (tabla en la misma DB, vía Prisma):** solo errores (no requests exitosos). Se escribe desde el `GlobalExceptionFilter`. Escritura **best-effort**: un fallo al loguear nunca debe alterar ni bloquear la respuesta al cliente.
- **Logging general (requests, trazabilidad):** `Logger` de NestJS + interceptor global para requests entrantes/salientes (método, ruta, tiempo de respuesta, status). Destino: **consola/Vercel únicamente por ahora** — no se conecta ningún servicio externo (Axiom, Better Stack) en esta fase. Los logs de request normales no se persisten en base de datos.
- **Nunca se loguean datos sensibles:** contraseñas, JWTs completos, tokens — ni en `ErrorLog` ni en consola.
- **Serialización segura de `BigInt` (agregado por la capa de datos, §3.11):** los montos de dinero son `BigInt`, que no es serializable nativamente a JSON. Dos medidas obligatorias: **(1)** el override `BigInt.prototype.toJSON` se registra en la **primera línea del bootstrap**, antes de instanciar el `GlobalExceptionFilter` o cualquier provider — si se registra después, un error temprano que arrastre montos lanza `TypeError` *dentro* del manejador de errores; **(2)** la escritura de `metadata` a `ErrorLog` usa un **serializador defensivo**: cualquier valor que no pueda convertirse se reemplaza por un string legible (ej. `"[no serializable: BigInt]"`) en lugar de lanzar excepción. Es la aplicación concreta del principio best-effort ya establecido arriba: un fallo de serialización nunca debe convertirse en un segundo error para el usuario.

| Qué | Dónde vive | Cuándo se escribe |
|---|---|---|
| Errores tipados + Exception Filter global | Código (NestJS) | Siempre que hay una excepción |
| Log de errores | Tabla `ErrorLog` (misma DB, Prisma) | Solo cuando hay error real (dentro del filter), best-effort |
| Logs de requests normales (interceptor) | Consola/Vercel | Cada request, éxito o error |

---

## 5. MCP (acceso en nombre de usuario)

- El MCP es un cliente más de la API: **no existe ninguna ruta de bypass de auth para él** en `AuthGuard`.
- El MCP actúa **en nombre de un usuario específico** — necesita el JWT/refresh token de ese usuario, no un token genérico.
- **Fase actual (uso propio, un solo usuario):** refresh token guardado en variable de entorno del proceso MCP (`MCP_USER_REFRESH_TOKEN`). Lógica de refresh de access token aislada en un módulo/función propia del MCP (no hardcodeada en cada llamada), para poder migrar el origen del refresh token sin tocar cómo se usa.
- El MCP le pega siempre a la API NestJS (nunca directo a Supabase/Prisma) — la autorización y validación de negocio quedan centralizadas en el backend.
- El `userId` usado en cualquier acción del MCP proviene siempre del JWT decodificado por el backend, nunca de un parámetro enviado por el MCP.

### Fase 2 — exposición a otros usuarios (diseño confirmado, implementación diferida)

- Tabla `McpConnection` (`userId`, `refreshToken` encriptado, timestamps) para almacenar la conexión por usuario.
- El `refreshToken` se almacena **encriptado en la base de datos** (mecanismo de encriptación/desencriptación específico queda por definir al momento de implementar esta fase, pero la decisión de encriptar ya está tomada).
- Flujo de "conectar cuenta" (equivalente a un login inicial) para que cada usuario autorice al MCP a actuar en su nombre.
- Manejo explícito de reconexión cuando el refresh token expira o se revoca (mensaje claro al usuario, no un 500 genérico).
- Esta fase no se implementa hasta que se decida exponer el MCP más allá del uso personal actual.

---

## 6. Rate limiting

**Diferido por completo.** No se implementa rate limiting en ningún endpoint (incluyendo login) en la fase actual. Cuando se decida implementarlo, la opción evaluada es `@nestjs/throttler` con store en Redis (ej. Upstash, por compatibilidad con el entorno serverless de Vercel) — necesario porque el estado en memoria no es confiable entre invocaciones serverless.

---

## 7. Testing

Pirámide clásica, apoyada en el desacoplamiento por interfaces (Dependency Inversion):

| Capa | Tipo de test | Qué mockea | Cantidad |
|---|---|---|---|
| Services (lógica de negocio) | Unit | Repositories (interfaces) | Muchos |
| Validadores custom | Unit | Nada | Pocos |
| `AuthGuard` | Unit | `IAuthRepository` | Pocos |
| Repositories (Prisma) | Integration | Nada — DB de test real | Algunos |
| `GlobalExceptionFilter` | Integration | Nada | Pocos |
| Flujos completos (login, acción crítica de negocio) | E2E | Nada — app completa | Muy pocos |

**DB de test para integration tests: Postgres local vía Docker.** Se levanta un contenedor de Postgres para correr migraciones de Prisma y ejecutar los tests de integración de repositories y del `GlobalExceptionFilter`, aislado de cualquier instancia real de Supabase.

**No se testea:** getters/setters triviales, DTOs simples sin lógica custom, código de framework.

**No se testea RLS (precisión agregada por la capa de datos, §3.8).** Verificar policies requiere `auth.uid()`, los roles `anon`/`authenticated`/`service_role` y JWTs emitidos por GoTrue — nada de eso existe en un contenedor de Postgres plano. Se descartó emular ese contexto (contradice el aislamiento que motiva usar Docker) y también usar una instancia real de Supabase para test. **Consecuencia asumida:** las policies se escriben y despliegan, pero su corrección **no está verificada automáticamente**; un error en una policy no sería detectado por la suite. El aislamiento real entre usuarios lo garantizan el filtro por `user_id` en cada `Repository` y el parámetro obligatorio `p_user_id` de las funciones de consulta (§3.9). RLS permanece como capa secundaria de defensa en profundidad, no verificada.

---

## 8. Frontend

- **Next.js con App Router** (confirmado).
- **Atomic Design** (atoms → molecules → organisms → templates → pages) para la composición visual. Atoms/molecules no conocen la API; solo reciben props.
- **API Client centralizado** (`lib/api/client.ts`): ningún componente hace `fetch()` directo contra el backend. Servicios por dominio (`ordersApi`, etc.) envuelven al cliente, espejo de los módulos de NestJS.
- **Reglas de uso por tipo de operación:**

| Necesita | Usa |
|---|---|
| Mostrar datos al cargar la página | Server Component |
| Guardar/actualizar/borrar (form submit) | Server Action |
| Interactividad fina sin recargar (búsqueda en vivo, polling) | Client Component + API Client |

- **Sesión:** manejada por `@supabase/ssr`, cookies httpOnly; el JWT nunca se maneja manualmente en `localStorage`.
- **`anon key`** expuesta en frontend — es pública por diseño. **`service_role key`** nunca se usa ni expone en frontend.

---

## 9. Decisiones

| Decisión | Razón | Alternativa descartada |
|---|---|---|
| Validar JWT localmente con las llaves públicas del JWKS de Supabase, dentro de `AuthGuard`/`SupabaseAuthRepository` | Stateless real: no depende de disponibilidad de la API de Supabase por request; menor latencia | `supabase.auth.getUser(token)` (round-trip a Supabase por cada request) |
| Sesión en cookies httpOnly vía `@supabase/ssr` | Inmune a robo de token por XSS | JWT en `localStorage` manejado manualmente |
| Repository pattern para auth (`IAuthRepository` + `SupabaseAuthRepository`) | Permite sustituir proveedor de auth sin tocar `AuthGuard`, services ni controllers | Llamadas directas a `supabase.auth.*` regadas en el código |
| Prisma con conexión directa, actuando como service role (bypass de RLS en su propio acceso) | Autorización centralizada en código, consistente con la arquitectura en capas | Depender de RLS como único mecanismo de autorización |
| **RLS activo en Supabase como defensa en profundidad** | Protege ante acceso futuro que no pase por el backend (fuga de anon key, Realtime, etc.); costo bajo de mantener | Dejar RLS completamente desactivado |
| Excepciones tipadas + `GlobalExceptionFilter` único | Respuesta de error consistente; nunca se filtran stack traces ni errores crudos | Manejo de errores ad-hoc por endpoint |
| `ErrorLog` como tabla simple en la misma DB (Supabase/Prisma) | Volumen de tráfico bajo actualmente; evita herramienta externa antes de necesitarla | Logging de errores solo en consola/Vercel (efímero) |
| Escritura a `ErrorLog` best-effort | Un fallo al loguear no debe convertirse en un segundo error para el usuario | Escritura síncrona y bloqueante del log |
| **Logs de request/interceptor solo a consola/Vercel, sin servicio externo por ahora** | No se justifica el costo/setup de Axiom/Better Stack en esta fase | Conectar Axiom o Better Stack desde ya |
| MCP autentica como cliente normal, con el JWT del usuario en cuyo nombre actúa | Mantiene un solo modelo de seguridad para todos los consumidores de la API | Excepción/bypass de auth específico para el MCP |
| MCP (fase actual, un solo usuario): refresh token en variable de entorno | Simplicidad para la fase actual sin cerrar la puerta a multi-usuario | Tabla `McpConnection` desde ya |
| **Refresh token del MCP, en su fase futura (`McpConnection`), se almacena encriptado** | Mitiga impacto de una eventual fuga de la base de datos | Guardar el refresh token en texto plano |
| `userId` de cualquier acción (incluyendo MCP) siempre sale del JWT decodificado | Evita suplantación vía parámetro manipulado | Confiar en un `userId` explícito enviado por el cliente/MCP |
| **Rate limiting diferido por completo, ningún endpoint lo implementa aún** | Tráfico bajo actual no lo justifica; se prioriza otro trabajo primero | Implementar throttling básico en login desde ya |
| **Sin modelo de roles en esta fase** — un solo tipo de usuario | No hay requerimiento de negocio actual que lo justifique | Diseñar `role` en `profiles`/`user_metadata` desde ya |
| **DB de test para integration tests: Postgres local vía Docker** | Aislamiento total de cualquier instancia real de Supabase; reproducible en CI | Segunda instancia de Supabase cloud dedicada a test |
| **Frontend: Next.js App Router** | Permite Server Components/Server Actions tal como se diseñó el flujo de datos | Pages Router |

## Fase 2 / fuera de alcance actual

- Implementación completa de `McpConnection` (tabla, flujo de conexión OAuth-like, mecanismo específico de encriptación del refresh token, manejo de reconexión).
- Rate limiting (`@nestjs/throttler` + Redis) en cualquier endpoint.
- Modelo de roles/permisos, si el negocio lo llegara a requerir.
- Conexión a servicio externo de logging (Axiom/Better Stack) si el volumen de logs lo justifica más adelante.
