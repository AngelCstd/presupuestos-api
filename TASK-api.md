# TASK-api.md

> **Destinatario:** agente autónomo implementando sin supervisión turno por turno.
> **Fuente de verdad del diseño:** `ARCHITECTURE.md`, §1–§9. Este documento describe **qué construir, en qué orden, y cómo verificar cada pieza**. No repite las justificaciones. Ante cualquier ambigüedad, `ARCHITECTURE.md` manda.
> **Documento hermano:** `API-CONTRACT.md` contiene el contrato de cara al cliente (request/response en JSON). Los dos documentos describen la misma API; si divergen en una forma concreta, **`API-CONTRACT.md` manda sobre la forma del JSON** y este documento manda sobre todo lo demás.
> **Prerequisitos cerrados y en verde:** capa de datos (`TASK-db.md`) y capa de auth (`TASK-auth.md`). Esta tarea no toca ninguna de las dos.

---

# 0. Condición de paro

**Esta tarea se ejecuta en dos loops.** Cada uno tiene su propia condición de paro, binaria y verificable por comando. El loop 2 no arranca hasta que el loop 1 esté cerrado.

| Loop | Unidades | Script propio |
|---|---|---|
| **1 — infraestructura y catálogo** | A00, A01, A02, A03, A04, A05, A06 | `test:integration:api:core` |
| **2 — dominio** | A07, A08, A09, A10, A11 | `test:integration:api:domain` |

**Por qué el corte cae ahí.** El loop 1 termina donde acaba la infraestructura y empieza la lógica de negocio. **A03 (`LedgerModule`) va en el loop 1** aunque sirva sobre todo al 2: sus builders son funciones puras con tests unitarios, quedan en verde rápido, y le dan al loop 2 una base sólida desde la cual atacar lo difícil. Lo que se verifica de A03 en el loop 1 es el **repository** (`createWithEntries` invocado directamente), no los endpoints — esos son A07 y viven en el loop 2.

## 0.1 Condición de paro del loop 1

**Seis comandos, ejecutados por separado, los seis con código de salida `0`:**

```
npx tsc --noEmit -p tsconfig.json
```
```
npx prisma migrate status
```
```
npm run test:unit
```
```
npm run test:integration:api:core
```
```
npm run test:integration:auth
```
```
npm run test:integration:db
```

Los dos últimos son **regresión**: esta tarea no puede romper las capas ya cerradas. Si `test:integration:db` cambia su conteo de tests, el filtro de rutas está mal (§12, acción 2).

## 0.2 Condición de paro del loop 2

**Los seis anteriores, más:**

```
npm run test:integration:api:domain
```

**`test:integration:api:core` sigue siendo condición de paro del loop 2.** El loop 2 no puede cerrar rompiendo el loop 1.

## 0.3 Verificación final combinada

Una vez cerrados los dos loops, y solo entonces:

```
npm run test:integration
```

**Nunca se encadenan comandos con `&&`.** Cada uno se invoca solo y se lee su código de salida.

**Condición binaria. No hay juicio involucrado.**

**Por qué `prisma migrate status` está en ambas listas aunque esta tarea no cree migraciones.** Es exactamente esa la razón: **esta tarea entrega cero migraciones**. Debe seguir imprimiendo `Database schema is up to date!` sin migraciones nuevas. Si aparece una, el agente violó §8 y la tarea no está hecha aunque los tests estén en verde.

## 0.4 Reglas de operación del loop

1. **No se avanza de unidad con tests en rojo.** Cada unidad trae su lista; se cierran todos antes de pasar a la siguiente.
2. **No se marca una unidad como hecha modificando o borrando un test para que pase.** Si un test falla, se arregla la implementación. Si el test parece estar mal, es una decisión → §8.4.
3. **No se declara un loop terminado sin correr sus comandos completos**, aunque los tests de la última unidad estén en verde.
4. **Cualquier `TODO`, `@ts-ignore`, `it.skip`, `it.todo` o test comentado en el código entregado significa que el loop NO está terminado.**
5. **El loop 2 no arranca con el loop 1 en rojo.**

---

# 1. Alcance

**Dentro:**

- Siete módulos de dominio: `profile`, `accounts`, `categories`, `transactions`, `budget`, `recurring`, `insights`.
- Cuatro módulos compartidos de infraestructura: `AccountsDataModule`, `PeriodsDataModule`, `QueriesModule`, `LedgerModule`.
- Controllers, DTOs con `class-validator`, Services, interfaces de repository y sus implementaciones Prisma.
- Traducción de intención a partida doble (§4 de este documento).
- Idempotencia expuesta como header `Idempotency-Key`.
- Paginación por cursor (ledger) y por offset (el resto).
- Extensión del mapeo de errores existente con los códigos de dominio nuevos.
- Interceptor de perfil (`profile.interceptor.ts`) que resuelve `profiles` por request.
- Compensación presupuestal de captura tardía (§2.3), como parte de la escritura de ledger.
- Fixtures de contrato versionados (§11.1).

**Fuera:**

- **Cualquier migración de base de datos.** La capa de datos está cerrada. Ver §7.
- Frontend, MCP tools, rate limiting, cache, modelo de roles, multi-moneda.
- **`POST /periods/{id}/reopen`** — la reapertura de un periodo cerrado queda **fuera de alcance en v1** por decisión explícita (P-02 sigue sin resolver). Ver §2.3.
- Tests de RLS.
- Cualquier PENDIENTE de §3.14 no listado como resuelto en §2.

---

# 2. Decisiones tomadas para esta capa

Estas ya están decididas. El agente las especifica e implementa; **no las reabre**.

## 2.1 Estructura

| # | Decisión |
|---|---|
| D1 | Capas: `Controller → Service → interfaz de Repository → implementación Prisma`. Un Service **nunca** importa `PrismaClient` ni el SDK de Supabase. Un Controller **nunca** contiene lógica de negocio: valida entrada vía DTO, delega al Service, mapea la salida al DTO de respuesta. |
| D2 | Módulos de NestJS **por dominio**, no por capa técnica. No existen carpetas de primer nivel `controllers/`, `services/`, `repositories/`. |
| D3 | `accounts` y `categories` son módulos separados aunque compartan la tabla `accounts`. Comparten el repository vía `AccountsDataModule`. |
| D4 | **Ningún módulo de dominio importa a otro módulo de dominio.** Todo lo compartido vive en un módulo de infraestructura (`AccountsDataModule`, `QueriesModule`, `LedgerModule`) que **todos** los módulos de dominio importan, incluido `insights`. Esta regla es verificable: ver T-R05. |
| D5 | La API expone **intención**, no partida doble. No existe ningún endpoint que reciba un arreglo de entries. |
| D6 | REST orientado a recursos, con sub-recursos de acción (`POST /periods/{id}/close`) para las operaciones que no son CRUD. |
| D7 | Versionado `/api/v1` desde el día uno, vía `app.setGlobalPrefix('api/v1')`. |
| D8 | Los montos viajan como **string de centavos** en el JSON, en entrada y en salida. Nunca como número. |
| D9 | Idempotencia vía header `Idempotency-Key`, **obligatorio** en los endpoints que escriben ledger. |
| D10 | Paginación por **cursor** en ledger (`/transactions`, `/accounts/{id}/ledger`, `/categories/{id}/ledger`); por **offset** en el resto. |
| D11 | El formato de error existente (`GlobalExceptionFilter` de `TASK-auth`) se **extiende** con un campo `code`. No se crea un formato paralelo. |
| D12 | Una transacción cuyo `bookedAt` cae en un periodo cerrado **compensa su impacto presupuestal en el periodo abierto actual**, en la misma transacción de base de datos. Ver §2.3. |

## 2.2 PENDIENTES de §3.14 resueltos para esta capa

Estos cuatro se decidieron explícitamente para poder cerrar el contrato. **Ninguno modifica la capa de datos.**

| PENDIENTE | Decisión | Efecto en la API |
|---|---|---|
| **P-04** — ventana de visibilidad en la carrera de idempotencia | Responder **`409 Conflict`** con código `IDEMPOTENCY_IN_FLIGHT` y header `Retry-After: 1`. **No** reintento de lectura del lado servidor. | El cliente reintenta con **la misma** llave y obtiene la fila. La petición no falló; todavía no se puede resolver. |
| **P-02** — algoritmo de reapertura | **Fuera de alcance en v1.** No existe `POST /periods/{id}/reopen`. | El escenario que la reapertura resolvía se cubre por otra vía: la **compensación al periodo abierto actual** (§2.3). |
| **P-01** — cierre sin periodo siguiente | Responder **`409 Conflict`** con código `NEXT_PERIOD_REQUIRED` y mensaje accionable. **No** se crea el periodo automáticamente. | Es 409 y no 400: la petición es válida, el estado del recurso es el que no la permite. |
| **P-05** — default de `profiles.timezone` | `'America/Mexico_City'`, ya presente en la migración de `profiles`. | `GET /me` siempre devuelve un `timezone` no nulo. |

**Los demás PENDIENTES siguen abiertos y siguen prohibidos** (P-03 categoría "Pérdidas", P-06, P-07, P-08 a P-11). Ver §7.1.

## 2.3 Captura tardía — compensación al periodo abierto actual

**Este es el comportamiento por default que `ARCHITECTURE.md` §3.10 ya documentaba** — *"la app avisa y ofrece: **(default)** aplicar el impacto presupuestal al periodo actual, o reabrir el periodo cerrado"*. Con P-02 fuera de alcance, la segunda opción desaparece y **la primera se aplica automáticamente**. No es una decisión nueva: es el default documentado, finalmente implementado.

**Por qué no puede quedar como limitación.** Capturar un gasto días después de que ocurrió, con la quincena ya cerrada, no es un caso raro en una app de presupuesto personal: es el flujo normal. Dejar ese estado sin salida sería dejar sin salida el caso de uso principal.

### Mecánica

**Sin tocar la capa de datos.** Para **toda** escritura de ledger cuyo `bookedAt` caiga dentro del rango de un periodo con `closed_at IS NOT NULL`:

1. La transacción se registra con su `bookedAt` **real**. El ledger nunca miente sobre cuándo ocurrió el gasto.
2. El Service resuelve el **periodo abierto actual** — el que cubre hoy según `profile.timezone`.
3. En **la misma transacción de base de datos**, por cada categoría afectada por la escritura se inserta un `budget_entry` en ese periodo actual, con `source = 'manual'`, `amount_cents` igual al **negativo del movimiento de esa categoría**, y una `note` que identifica la transacción de origen.

**Efecto:** el disponible del periodo actual baja por ese gasto, que es lo correcto — el dinero salió y hay que cubrirlo. El periodo cerrado conserva su sobregiro histórico, honesto e intocado. F2 sigue derivando `gastado` de `booked_at` sin ningún cambio, y F3 trata el resultado exactamente igual que a un gasto capturado a tiempo.

### Decisiones puntuales

| Punto | Decisión |
|---|---|
| **Regla de disparo** | Se compensa **todo movimiento contra una categoría**, no una lista de endpoints. Cae solo donde debe caer: `/transactions/expenses`, `/transactions/loan-write-offs`, `/recurring-templates/{id}/confirm` y las reversas de cualquiera de las tres. `/incomes`, `/transfers`, `/loans`, `/loan-repayments` y `/opening-balances` no tocan categorías y nunca compensan. |
| **Varias `lines`** | **Un entry compensatorio por categoría distinta**, agregando los movimientos de esa categoría dentro de la misma transacción. Si el mismo `categoryId` aparece dos veces en `lines`, se emite **un solo** compensatorio por la suma. `budget_entries` no tiene forma de referenciar una línea individual, así que dos filas idénticas serían ruido indistinguible. |
| **Sin periodo abierto actual** | **No se compensa.** La transacción se crea igual y la respuesta lo reporta con `budgetImpact.status = "uncompensated"`. **Nunca se rechaza la transacción por esto.** |
| **Reversas** | Cae bajo la misma regla, sin caso especial. Los entries de una reversa tienen signo invertido, así que el compensatorio sale **positivo** y neutraliza al original. Como `bookedAt` de la reversa hereda por default el del original, la reversa de una captura tardía compensa automáticamente. |
| **Reversa con `bookedAt` sobreescrito** | **Prohibido a nivel de backend cuando el original generó compensatorio.** Si el `bookedAt` del original cae en un periodo cerrado y el cliente manda `bookedAt` en el body de la reversa, se rechaza con `422 REVERSAL_DATE_LOCKED` antes de escribir nada. Ver "Fecha bloqueada en reversas compensadas" abajo. |
| **Categoría archivada** | No aplica en la práctica: S-R9 ya bloquea escribir ledger contra una cuenta archivada. La excepción son las reversas, que sí pueden generar un compensatorio contra un sobre archivado. Es correcto — el dinero se devuelve al sobre que lo gastó. |

### Consecuencia asumida — la única

**Si el insert del compensatorio falla, el gasto tampoco se registra.**

Existe una ventana real: el periodo abierto actual se cierra desde otra sesión entre que el Service lo resuelve y que el insert ocurre, R11 dispara, y la transacción completa se revierte. Eso contradice la regla de fondo de §3.10 (*"el ledger de dinero nunca rechaza una transacción"*).

**No hay forma de tener las dos cosas.** Sacar el compensatorio a una escritura separada rompe la atomicidad y deja el estado a medias, que es peor. Se acepta la ventana:

- El cliente recibe `409 PERIOD_CLOSED` y **cero filas escritas**.
- Reintenta con **la misma** `Idempotency-Key`; el Service vuelve a resolver el periodo actual y el reintento sale limpio.
- La ventana es de milisegundos y exige que el mismo usuario cierre un periodo desde otra sesión en ese instante exacto.

Está documentado como consecuencia asumida, no como bug.

**Nota agregada durante la implementación de A07 (T-S14, verificado empíricamente con Luis).** La resolución del periodo objetivo (`findOpenPeriodCoveringDate`) filtra `closed_at IS NULL` — es lo correcto, y es lo que hace que `T-S05` (sin periodo abierto) dé `uncompensated` en vez de tronar. Una consecuencia de ese filtro, verificada dos veces (cerrando el periodo por SQL directo *antes* de la petición, sin ninguna carrera): el escenario de esta sección **no se puede reproducir desde fuera de forma determinista**. Cerrar el periodo antes de que llegue la petición da `uncompensated` (`T-S05`), no el choque contra R11 — porque el Service nunca vuelve a intentar usar un periodo que su propia lectura ya descartó. La única forma de alcanzar el choque real es que el cierre ocurra en el intervalo de milisegundos entre esa lectura y el `INSERT` del compensatorio, dentro de la misma petición — y cuatro intentos con distintos tiempos de espera (50ms, 10ms, 1ms, sin espera) nunca lo lograron disparar. **No se agregó un `FOR UPDATE` ni ningún otro lock para hacerlo determinista** — nada en este documento lo pide, y diseñar el código para que un test pueda ganarle a una carrera que ya es correcta por sí misma habría sido dejar que el test dictara el diseño. La ventana sigue existiendo en el código (`resolveLateCaptureCompensation` lee el periodo objetivo en una consulta separada del `INSERT` de `createWithEntries` — no están en la misma transacción), pero no tiene un test automatizado que la ejerza: queda verificada por revisión del código y por este razonamiento, no por una corrida reproducible. `T-S14` se retiró de la suite por esta razón.

---

---

# 3. Reglas de Service

Las cuatro de U24 (`TASK-db.md`) se transfieren aquí íntegras, más cinco nuevas.

## 3.1 Heredadas de U24 — normativas

| ID | Regla |
|---|---|
| **S-R1** | `transaction` + `entries` **siempre** en la misma transacción de base de datos. Sin excepción. Implementado en un único lugar: `PrismaTransactionRepository.createWithEntries()`. |
| **S-R2** | Precondiciones del cierre: el periodo siguiente debe existir **y** tener `closed_at IS NULL`. Rechazar con excepción tipada **antes** de tocar la base. |
| **S-R3** | Filtro por `user_id` en **cada** método de **cada** repository. RLS no está testeada y Prisma la bypassa. Ningún método de repository puede tener una firma sin `userId`. |
| **S-R4** | `archived_at` filtra **solo** en endpoints de listado/selección; **nunca** en cálculos. F1–F4 se consumen sin filtrar archivadas. |

## 3.2 Nuevas de esta capa

| ID | Regla | Estado |
|---|---|---|
| **S-R5** | **No se permite cambiar `currency` de una cuenta que ya tiene entries.** R4 solo dispara al insertar; sin esta regla, cambiar la moneda de una cuenta con historial deja transacciones pasadas mezclando monedas sin que ningún trigger lo detecte. Verificación: `SELECT 1 FROM entries WHERE account_id = $1 AND user_id = $2 LIMIT 1`. | ✅ aprobada |
| **S-R6** | **No se permite archivar un sobre (`type='expense'`) que tenga `budget_entries` vigentes en algún periodo abierto.** Acota la política general de archivado: R8 exime a `expense` del saldo cero, pero dinero apartado en un sobre invisible sigue contando como `comprometido` en F3, y el usuario vería su dinero disponible bajar sin explicación visible. Archivar sigue siendo libre si no hay asignaciones vigentes en periodos abiertos. | ✅ aprobada — **acota explícitamente D3 de §2.1** |
| **S-R7** | **No se permite revertir una reversa.** Si la transacción objetivo tiene `reverses_transaction_id IS NOT NULL`, se rechaza. `reverses_transaction_id` está diseñado como **par**, no como cadena: permitir `X ← R1 ← R2` crea cadenas que ninguna parte de `ARCHITECTURE.md` contempla recorrer. Deshacer un deshacer se hace registrando una transacción nueva. | ✅ aprobada |
| **S-R8** | **No se permite cerrar un periodo si existe otro periodo abierto anterior** (`starts_on` menor, `closed_at IS NULL`, `deleted_at IS NULL`). Derivada de §3.10: *"presentar los cierres pendientes en orden cronológico y no ofrecer cerrar un periodo si existe otro anterior sin cerrar"*. Con P-02 fuera de alcance, un cierre desordenado es un **callejón sin salida permanente**; la regla lo impide en el servidor y no solo en la UI. | ✅ aprobada |
| **S-R9** | **No se permite escribir ledger contra una cuenta archivada**, de ningún `type`. Devolver `409 ACCOUNT_ARCHIVED`. No contradice S-R4: S-R4 habla de **cálculos y listados**; esta regla habla de **escrituras nuevas**. Archivar sin bloquear escrituras deja el archivado sin significado operativo. **Exime a las reversas** (§4.8, punto 5). | ✅ aprobada |

**S-R10 (transversal, no negociable):** el `userId` de cualquier operación proviene **siempre** del JWT decodificado por `AuthGuard`, adjuntado al request. Ningún DTO puede declarar un campo `userId`. Con `forbidNonWhitelisted` activo, un cliente que lo mande recibe `400`.

---

# 4. Traducción de intención a partida doble

**El núcleo de esta tarea.** Cada intención se traduce a entries balanceados por una **función pura**, sin I/O, unitariamente testeable sin base de datos — mismo criterio que `nextDueOn` en U08b.

Todas viven en `src/shared/ledger/entry-builders.ts` y comparten esta forma:

```ts
export interface EntryDraft {
  accountId: string;
  amountCents: bigint;   // con signo; nunca 0
}
```

**Invariante de todas ellas:** `entries.reduce((a, e) => a + e.amountCents, 0n) === 0n`, y `entries.length >= 2`. Cualquier builder que pueda producir menos de 2 entries o un entry en `0n` está mal implementado.

**Roles de cuenta.** El Service valida los `type` **antes** de llamar al builder. Los builders asumen entrada ya validada y no consultan la base.

| Rol en el request | `type` permitido |
|---|---|
| `paidFromAccountId`, `fromAccountId`, `toAccountId` | `asset`, `liability` |
| `categoryId`, `lines[].categoryId` | `expense` |
| `sourceId` | `income` |
| `receivableAccountId`, `lentTo[].receivableAccountId` | `receivable` |
| (ninguno — resuelto por el Service) | `equity` |

**`equity` nunca es direccionable por el cliente.** La cuenta ancla se resuelve internamente con `IAccountRepository.findSystemEquity(userId)`. Un `accountId` que apunte a una cuenta `is_system = true` se rechaza con `403 SYSTEM_ACCOUNT_NOT_ADDRESSABLE`.

**Validación de moneda (previa a R4).** El Service carga todas las cuentas involucradas en un solo `findManyByIds` y verifica que compartan `currency`. Si difieren → `422 MIXED_CURRENCY` **antes** de tocar la base. R4 sigue siendo la red de último recurso, no el mecanismo primario.

## 4.1 `buildExpenseEntries` — registrar un gasto

```ts
buildExpenseEntries(input: {
  paidFromAccountId: string;
  lines: Array<{ categoryId: string; amountCents: bigint }>;
  lentTo?: Array<{ receivableAccountId: string; amountCents: bigint }>;
  totalCents: bigint;
}): EntryDraft[]
```

**Reglas:**
1. `sum(lines) + sum(lentTo ?? []) === totalCents`, exacto. Si no → `422 SPLIT_TOTAL_MISMATCH`. **El residuo de un reparto equitativo lo calcula el cliente** (§3.11); la API solo verifica que las partes sumen el total.
2. Todos los montos de `lines` y `lentTo` son **estrictamente positivos**. `totalCents > 0`.
3. `lines.length >= 1`.
4. Entries producidos: `paidFromAccountId` con `−totalCents`; cada `line` con `+amountCents`; cada `lentTo` con `+amountCents`.
5. Si un mismo `categoryId` aparece dos veces en `lines`, **no se colapsa**: se emiten dos entries. Postgres no lo prohíbe y colapsarlos perdería la intención del cliente.

**Ejemplo canónico — Wifi $700 con tarjeta:**

```
paidFromAccountId = TDC, totalCents = 70000n
lines = [{ Gasto:Wifi, 70000n }]
→ [ { TDC, -70000n }, { Gasto:Wifi, +70000n } ]
```

**Ejemplo canónico — cena $800 con TDC, mitad prestada a Fer:**

```
paidFromAccountId = TDC, totalCents = 80000n
lines  = [{ Gasto:Comida, 40000n }]
lentTo = [{ PorCobrar:Fer, 40000n }]
→ [ { TDC, -80000n }, { Gasto:Comida, +40000n }, { PorCobrar:Fer, +40000n } ]
```

## 4.2 `buildIncomeEntries` — registrar un ingreso

```ts
buildIncomeEntries(input: {
  toAccountId: string;
  sourceId: string;
  amountCents: bigint;   // > 0
}): EntryDraft[]
```

Entries: `toAccountId` con `+amountCents`; `sourceId` con `−amountCents`.

**Ejemplo canónico — nómina $10,000 a Nu:**

```
→ [ { Nu, +1000000n }, { Sueldo, -1000000n } ]
```

## 4.3 `buildTransferEntries` — transferir entre cuentas

```ts
buildTransferEntries(input: {
  fromAccountId: string;
  toAccountId: string;
  amountCents: bigint;   // > 0
}): EntryDraft[]
```

Entries: `fromAccountId` con `−amountCents`; `toAccountId` con `+amountCents`.

**`fromAccountId !== toAccountId`**, si no → `422 SAME_ACCOUNT_TRANSFER`.

**El pago de tarjeta de crédito usa este endpoint.** Es mecánicamente idéntico a una transferencia. **No toca ninguna categoría de gasto**: el gasto ya se contabilizó cuando se hizo la compra. Contabilizarlo dos veces es el error más común del dominio (§3.2). Un `toAccountId` de tipo `expense` es rechazado por la validación de rol.

**Ejemplo canónico — pago de tarjeta $700 desde Nu:**

```
→ [ { Nu, -70000n }, { TDC, +70000n } ]
```

## 4.4 `buildLoanEntries` — prestar dinero

```ts
buildLoanEntries(input: {
  fromAccountId: string;
  receivableAccountId: string;
  amountCents: bigint;   // > 0
}): EntryDraft[]
```

Entries: `fromAccountId` con `−amountCents`; `receivableAccountId` con `+amountCents`.

**No toca ninguna categoría.** Mientras el préstamo es cobrable, el dinero solo cambió de forma (`asset` → `receivable`) y **no es un gasto** (§3.2).

**Ejemplo canónico — préstamo de $500 a Fer:**

```
→ [ { Nu, -50000n }, { PorCobrar:Fer, +50000n } ]
```

## 4.5 `buildLoanRepaymentEntries` — cobrar un préstamo

```ts
buildLoanRepaymentEntries(input: {
  receivableAccountId: string;
  toAccountId: string;
  amountCents: bigint;   // > 0
}): EntryDraft[]
```

Entries: `toAccountId` con `+amountCents`; `receivableAccountId` con `−amountCents`.

**Se permiten cobros parciales.** El Service **no** valida que `amountCents` sea menor o igual al saldo pendiente del `receivable`: sobrecobrar deja el `receivable` en negativo, que es un estado detectable y corregible con una reversa. Bloquearlo exigiría leer un saldo derivado dentro de una escritura y no aporta garantía contable.

**Ejemplo canónico:**

```
→ [ { Nu, +50000n }, { PorCobrar:Fer, -50000n } ]
```

## 4.6 `buildLoanWriteOffEntries` — préstamo incobrable

```ts
buildLoanWriteOffEntries(input: {
  receivableAccountId: string;
  categoryId: string;     // type = 'expense'
  amountCents: bigint;    // > 0
}): EntryDraft[]
```

Entries: `receivableAccountId` con `−amountCents`; `categoryId` con `+amountCents`.

**Es el único momento en que un préstamo impacta el presupuesto** (§3.2). El `categoryId` **lo manda el cliente**: P-03 (si la categoría "Pérdidas" se siembra, se crea al primer uso, o la crea el usuario) **sigue sin resolver y no se resuelve aquí**. El Service no crea ninguna categoría, no busca una llamada "Pérdidas", y no aplica ningún default.

**Ejemplo canónico — préstamo incobrable de $500:**

```
→ [ { PorCobrar:Fer, -50000n }, { Gasto:Pérdidas, +50000n } ]
```

## 4.7 `buildOpeningBalanceEntries` — saldo inicial

```ts
buildOpeningBalanceEntries(input: {
  balances: Array<{ accountId: string; balanceCents: bigint }>;  // con signo
  equityAccountId: string;
}): EntryDraft[]
```

**Reglas:**
1. Los `balanceCents` **llevan signo** y son el saldo natural del tipo de cuenta: `asset` y `receivable` positivos, `liability` negativo.
2. Las entradas con `balanceCents === 0n` **se descartan** antes de construir. Un entry en cero viola `entries_amount_nonzero`.
3. Tras descartar ceros, si quedan **cero** cuentas → `422 EMPTY_OPENING_BALANCE`.
4. `residual = −sum(balanceCents)`. Si `residual !== 0n`, se agrega el entry de cuadre contra `equityAccountId`. **Si `residual === 0n`, el entry de equity se omite** — agregarlo en cero violaría `entries_amount_nonzero`.
5. Tras el paso 4, si `entries.length < 2` → `422 EMPTY_OPENING_BALANCE`. Solo puede ocurrir con una cuenta cuyo saldo se cancele contra nada, que el paso 3 ya excluye; la verificación queda como red.
6. Los `type` permitidos en `balances` son `asset`, `liability`, `receivable`. Una categoría o una fuente de ingreso no tiene "saldo inicial".

**Ejemplo canónico — onboarding:**

```
balances = [ { Nu, +1000000n }, { TDC, -250000n }, { Efectivo, +80000n } ]
sum = 830000n → residual = -830000n
→ [ { Nu, +1000000n }, { TDC, -250000n }, { Efectivo, +80000n }, { SaldoInicial, -830000n } ]
```

**Se permite invocarlo más de una vez.** Un usuario que agrega una cuenta meses después necesita capturar su saldo. No hay ninguna marca de "ya se hizo el onboarding".

## 4.8 `buildReversalEntries` — revertir una transacción

```ts
buildReversalEntries(originalEntries: EntryDraft[]): EntryDraft[]
```

Devuelve los mismos entries con **todos los signos invertidos**, en el mismo orden. Como el original suma cero, la reversa suma cero, y su magnitud (`SUM(amount) FILTER (WHERE amount > 0)`) coincide por construcción con la del original, satisfaciendo R9 sin cálculo adicional.

**El Service, antes de construir:**
1. Carga la transacción original con sus entries. Si no existe o no es del usuario → `404 TRANSACTION_NOT_FOUND`.
2. Si `original.reversesTransactionId !== null` → `409 CANNOT_REVERSE_REVERSAL` (S-R7).
3. Si ya existe una reversa de esa transacción → `409 ALREADY_REVERSED`. Se pre-verifica con `findReversalOf()`; el índice único `transactions_reverses_uniq` es la red de último recurso y su `23505` mapea al mismo código.
4. **`bookedAt` de la reversa.** El default es siempre el `bookedAt` del original, para que la corrección caiga en el mismo periodo presupuestal que el gasto que corrige.

   **Si el `bookedAt` del original cae dentro de un periodo cerrado** — es decir, si esa transacción generó compensatorios — el campo `bookedAt` del body **se rechaza** con `422 REVERSAL_DATE_LOCKED`, antes de escribir nada. Omitirlo es válido y es el camino normal.

   **Por qué se bloquea en el servidor y no se pide por documentación.** El compensatorio de una captura tardía es un `budget_entry` que no tiene forma de referenciar la transacción que lo originó (hueco H7). Si la reversa se registra con una fecha que cae en un periodo abierto, no genera el compensatorio inverso, y el del original **queda huérfano**: el sobre del periodo actual sigue descontado por un gasto que ya se revirtió, sin nada que lo señale ni forma de detectarlo después. Confiar en que el cliente omita el campo deja una regla de integridad viviendo fuera del backend.

   La condición se deriva del mismo cálculo que el Service ya hace para decidir si compensa; no requiere columna nueva ni consulta adicional.

   Si el `bookedAt` del original **no** cae en un periodo cerrado, el campo sigue siendo sobreescribible con normalidad.
5. **No revalida S-R9 (cuenta archivada) sobre las cuentas del original.** Una reversa es una corrección; bloquearla porque una cuenta se archivó después dejaría el error sin remedio.

## 4.9 `buildBudgetCompensations` — captura tardía

**Función pura, sin I/O**, igual que las anteriores. Implementa §2.3.

```ts
export interface BudgetCompensationDraft {
  periodId:    string;
  categoryId:  string;
  amountCents: bigint;   // nunca 0
  note:        string;
}

buildBudgetCompensations(input: {
  entries:       EntryDraft[];
  categoryIds:   Set<string>;   // qué accountIds son de tipo `expense`
  targetPeriodId: string;       // el periodo abierto actual
  transactionId: string;
  bookedAt:      string;        // YYYY-MM-DD
}): BudgetCompensationDraft[]
```

**Reglas:**

1. Recorre `entries`; ignora todo entry cuyo `accountId` no esté en `categoryIds`.
2. **Agrega por `categoryId`**: si la misma categoría aparece en varios entries, se suman antes de emitir.
3. Emite un draft por categoría con `amountCents = −sumaDeEsaCategoría`.
4. **Descarta las categorías cuya suma sea `0n`.** Un `budget_entry` en cero viola `budget_entries_amount_nonzero`.
5. `note` con formato fijo: `` `Ajuste por captura tardía — tx <transactionId>, fecha <bookedAt>` ``.
6. Si no hay ninguna categoría afectada, devuelve `[]`. **No es un error.**

**El `transactionId` lo genera el Service** con `crypto.randomUUID()` antes de llamar al builder, y lo pasa a `createWithEntries` como parte del `TransactionDraft`. §3.3 de `ARCHITECTURE.md` permite explícitamente el UUID generado por la aplicación. Sin esto, la `note` no podría referenciar la transacción, porque el id no existiría hasta después del insert.

**Ejemplo canónico — gasto tardío:**

```
Hoy es 2026-08-20. P1 = 1–15 ago (cerrado), P2 = 16–31 ago (abierto).
Gasto de $500 en Comida con bookedAt = 2026-08-12.

entries → [ { Nu, -50000n }, { Comida, +50000n } ]
targetPeriodId = P2
→ [ { periodId: P2, categoryId: Comida, amountCents: -50000n, note: "Ajuste por captura tardía — tx 9a8b…, fecha 2026-08-12" } ]
```

**Ejemplo canónico — reversa de ese gasto:**

```
entries → [ { Nu, +50000n }, { Comida, -50000n } ]
→ [ { periodId: P2, categoryId: Comida, amountCents: +50000n, note: "…" } ]
```

Los dos compensatorios se anulan. **No hay caso especial para reversas**: la inversión de signo de §4.8 lo produce sola.

**Ejemplo — misma categoría dos veces:**

```
entries → [ { TDC, -70000n }, { Comida, +30000n }, { Comida, +40000n } ]
→ UN solo draft: { Comida, -70000n }
```

---

---

# 5. Mecánica transversal

## 5.1 Idempotencia

**Header:** `Idempotency-Key: <uuid v4>`.

**Obligatorio** en los nueve endpoints que escriben ledger (los siete de `/transactions/*`, `/transactions/{id}/reversal`, `/recurring-templates/{id}/confirm`). En cualquier otro endpoint el header se **ignora** en silencio.

| Situación | Respuesta |
|---|---|
| Header ausente en un endpoint que lo exige | `400` · `IDEMPOTENCY_KEY_REQUIRED` |
| Header presente pero no es un UUID válido | `400` · `IDEMPOTENCY_KEY_INVALID` |
| Llave nueva → escritura efectiva | `201` con el recurso creado |
| Llave ya usada, fila visible | `200` con **la misma** representación del recurso ya existente |
| Llave ya usada, fila **aún no visible** (la escritura original no ha hecho `COMMIT`) | `409` · `IDEMPOTENCY_IN_FLIGHT` + header `Retry-After: 1` |

**El único diferenciador entre creación y recuperación es el status: `201` vs `200`.** El cuerpo es idéntico. El cliente no necesita otra señal.

**Implementación — un solo lugar: `PrismaTransactionRepository.createWithEntries()`.**

```ts
async createWithEntries(
  userId: string,
  draft: TransactionDraft,                        // incluye el `id` generado por el Service
  entries: EntryDraft[],
  compensations: BudgetCompensationDraft[] = [],  // §4.9 — normalmente vacío
): Promise<CreateTransactionResult>   // { transaction, entries, created: boolean }
```

Dentro de un único `prisma.$transaction(async (tx) => { ... })`:

1. `INSERT INTO transactions (...) VALUES (...) ON CONFLICT (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING RETURNING id` — vía `$queryRaw`. **Nunca `INSERT` plano con captura de `23505`**: una violación de unicidad aborta la transacción completa y cualquier statement posterior falla con `25P02` (§3.5).
2. Si devolvió fila → `tx.entry.createMany(...)` con los entries, después `tx.budgetEntry.createMany(...)` con las `compensations` si las hay, y `created: true`. `COMMIT`.
3. Si **no** devolvió fila → `SELECT` de la transacción existente por `(user_id, idempotency_key)`.
   - Si aparece → se cargan sus entries y se devuelve con `created: false`.
   - Si **no** aparece → se lanza `IdempotencyInFlightException`. **Sin reintento, sin `sleep`, sin backoff** (P-04 decidido en §2.2).

**S-R1 vive aquí y solo aquí.** Ningún Service crea una `transaction` por su cuenta.

**Las compensaciones se escriben únicamente cuando `created === true`.** En la rama de recuperación por idempotencia no se escribe ninguna: la escritura original ya las puso. Un reintento **nunca** duplica el ajuste presupuestal. Es la razón por la que van dentro de este método y no en el Service.

**Si el `createMany` de compensaciones falla, todo se revierte**, incluida la transacción de ledger. Es la consecuencia asumida de §2.3, con su ventana de carrera documentada — sin test automatizado propio, ver la nota sobre T-S14 al final de §2.3.

**El cierre de periodo y las asignaciones no llevan `Idempotency-Key`**: la columna solo existe en `transactions`. Su protección es otra — `budget_entries_rollover_uniq` para la doble materialización, y la verificación de `closed_at` para el doble cierre.

## 5.2 Paginación

**Cursor — `/transactions`, `/accounts/{id}/ledger`, `/categories/{id}/ledger`.**

- Orden fijo y no configurable: `booked_at DESC, transaction_id DESC` (y `entry_id DESC` en los dos endpoints de ledger).
- Parámetros: `limit` (default `50`, máximo `100`), `cursor` (opaco).
- El cursor es `base64url(JSON.stringify({ b, t, e? }))` donde `b` es `bookedAt` (`YYYY-MM-DD`), `t` el `transaction_id` y `e` el `entry_id`. **El cliente lo trata como opaco**; el formato interno puede cambiar sin ser un cambio de contrato.
- Predicado: `WHERE (t.booked_at, t.id) < ($cursorB, $cursorT)`. La comparación de tuplas de Postgres funciona con `ORDER BY ... DESC` en ambas columnas.
- Respuesta: `{ "data": [...], "nextCursor": "..." | null }`. `nextCursor` es `null` **solo** cuando no hay más páginas.
- Un cursor mal formado o no decodificable → `400 INVALID_CURSOR`. Nunca se ignora en silencio.

**Offset — el resto de los listados.**

- Parámetros: `page` (base 1, default `1`), `pageSize` (default `50`, máximo `200`).
- Respuesta: `{ "data": [...], "page": 1, "pageSize": 50, "total": 12 }`.

## 5.3 Formato de error

`GlobalExceptionFilter` **ya existe** (`TASK-auth`) y responde con `statusCode`, `message`, `timestamp`, `path`. Esta tarea **agrega un campo `code`** y nada más.

```json
{
  "statusCode": 409,
  "code": "PERIOD_CLOSED",
  "message": "El periodo está cerrado y sus asignaciones no se pueden modificar.",
  "timestamp": "2026-08-09T18:22:41.108Z",
  "path": "/api/v1/periods/8f1c.../allocations"
}
```

**Cómo se llena `code`:**

- Si la excepción extiende `DomainException`, `code` sale de su propiedad `code`.
- Si es una `HttpException` de Nest sin `code`, se deriva del status: `400 → BAD_REQUEST`, `401 → UNAUTHORIZED`, `403 → FORBIDDEN`, `404 → NOT_FOUND`, `409 → CONFLICT`, `422 → UNPROCESSABLE_ENTITY`.
- Error no controlado → `500` con `code: "INTERNAL_ERROR"`. **Nunca** se expone el mensaje original ni el stack.

**Errores de validación** (`ValidationPipe`) agregan `details`:

```json
{
  "statusCode": 400,
  "code": "VALIDATION_FAILED",
  "message": "La petición no pasó validación.",
  "details": [{ "field": "amountCents", "constraint": "must be a string of integer cents" }],
  "timestamp": "...",
  "path": "..."
}
```

**Prohibido:** crear un segundo filtro, un interceptor de errores paralelo, o cambiar los cuatro campos existentes. La escritura a `ErrorLog` sigue siendo best-effort y sigue viviendo en el filtro, con el `.catch()` del lado del filtro y no dentro de `ErrorLogRepository.write()` (forma fijada de `TASK-auth`).

## 5.4 Mapeo de errores de Postgres

Los errores llegan desde `$queryRaw`/`$executeRaw` como `PrismaClientKnownRequestError` con `code === 'P2010'` y el SQLSTATE en `meta.code`. La discriminación de los `23505` se hace **por nombre de constraint**, nunca por el texto semántico del mensaje (§6 de `TASK-db.md`).

```ts
// src/common/errors/pg-error.ts
export function parsePgError(e: unknown): { sqlstate: string; constraint: string | null } | null;
```

`constraint` se extrae del nombre del constraint que Postgres reporta. La extracción tiene su propio test unitario por cada nombre de constraint de la tabla de §9.2 — es la única pieza textual del mapeo y por eso está cubierta caso por caso.

**Regla de precedencia:** el Service **pre-valida** todo lo que puede pre-validar y lanza la excepción tipada correspondiente. El mapeo de SQLSTATE es la ruta de carrera y de bug, no la ruta normal. Un test que provoque un error de trigger en el camino feliz indica que faltó una pre-validación.

## 5.5 Montos, fechas y nulos

| Convención | Regla |
|---|---|
| **Montos** | String de centavos enteros, en entrada y salida. Regex de validación: `/^-?\d{1,19}$/`. Sin punto decimal, sin separadores de miles, sin símbolo de moneda. Se transforma a `BigInt` en el DTO con un validador propio `@IsCentsString()` + `@Transform`. |
| **Salida de montos** | `BigInt.prototype.toJSON` (ya registrado en la primera línea del bootstrap por `TASK-auth`) los serializa como string automáticamente. **No se agrega ningún mapeo manual `.toString()` en los DTOs de respuesta.** |
| **Fechas de calendario** | `bookedAt`, `startsOn`, `endsOn`, `nextDueOn`, `lastConfirmedOn` → string `YYYY-MM-DD`. Validación `@IsDateString()` + regex estricta. **El cliente resuelve la fecha local antes de mandarla** (§3.6); el servidor no convierte nada. |
| **Instantes** | `createdAt`, `updatedAt`, `closedAt`, `archivedAt` → RFC 3339 en UTC con sufijo `Z`. |
| **Nulos** | Un campo opcional ausente y un campo en `null` significan lo mismo en **entrada**. En **salida**, un campo nulo se emite explícitamente como `null`; nunca se omite. Esto evita que el cliente tenga que distinguir "no aplica" de "no vino". |
| **Zona horaria** | La API **nunca** usa `now()` de Postgres ni la hora del servidor para decidir a qué periodo pertenece una fecha. Cuando un Service necesita "hoy" del usuario, lo calcula con `profile.timezone`. |

## 5.6 Vocabulario de cara al cliente

**La API nunca expone términos de partida doble.** No existe `debit`, `entry`, `asset`, `liability` ni `equity` en ningún nombre de campo ni valor de enum del contrato público. El mapeo es fijo y vive en los DTO de respuesta:

**Nota sobre "credit" — contradicción encontrada y resuelta al escribir T-R07 (sesión de tests del loop 1).** La redacción original de este párrafo también prohibía `credit`, pero la tabla de abajo lo declara como el valor legítimo de `kind` para `liability`, y `API-CONTRACT.md` lo usa en sus propios ejemplos JSON. **Gana el `kind` público**: `credit` es contrato de cara al cliente (tarjeta de crédito), no partida doble — a diferencia de `debit`, que sí es jerga contable pura sin ningún uso legítimo aquí. El grep de T-R07 excluye `credit` por esta razón.

| `type` en la base | `kind` en la API | Qué es para el usuario |
|---|---|---|
| `asset` | `cash` | Dinero propio disponible (banco, efectivo, débito) |
| `liability` | `credit` | Deuda propia (tarjeta de crédito) |
| `receivable` | `receivable` | Dinero que alguien te debe |
| `expense` | `category` | Un sobre de presupuesto |
| `income` | `income_source` | Una fuente de ingreso |
| `equity` | `system` | **Nunca se expone.** Filtrado en todos los endpoints |

**Regla de presentación del signo**, que `API-CONTRACT.md` debe documentar para el frontend:

| `kind` | Saldo natural | Cómo se pinta |
|---|---|---|
| `cash` | Positivo | Tal cual |
| `receivable` | Positivo | Tal cual, etiqueta "te deben" |
| `credit` | Negativo | Valor absoluto, etiqueta "debes" |
| `income_source` | Negativo | Valor absoluto |
| `category` | Positivo | Tal cual — gasto acumulado |

**La transformación depende exclusivamente del `kind`.** Nunca del nombre de la cuenta ni del contexto. La API devuelve el monto **crudo con signo** y el `kind`; el frontend aplica la tabla.

**Movimientos en respuestas de lectura.** `GET /transactions/{id}` y `GET /transactions` devuelven un arreglo `movements`, cada uno `{ accountId, accountName, accountKind, amountCents }`. Es la vista legible de lo que se movió, **no** una entrada de escritura: ningún endpoint acepta `movements` como input. Las respuestas de **creación** no lo incluyen (§6.7).

## 5.7 Resolución del perfil por request

`AuthGuard` adjunta `{ userId, email }`. Esta capa agrega un **interceptor global** que invoca `EnsureProfileExistsService.ensure(userId)` y adjunta el resultado como `request.profile`.

```ts
// src/common/interceptors/profile.interceptor.ts   → ProfileInterceptor
// src/common/decorators/current-user.decorator.ts  → @CurrentUser()    → { userId, email }
// src/common/decorators/current-profile.decorator.ts → @CurrentProfile() → ProfileRow
```

- **No se renombra ni se cambia la firma de `EnsureProfileExistsService.ensure`** — es forma fijada de `TASK-auth`.
- El interceptor corre **después** de `AuthGuard` y antes de cualquier controller.
- `ProfileDeletedException` (403) se propaga tal cual; el interceptor no la captura.
- **Antes de implementarlo, verificar si `TASK-auth` ya lo cableó** en algún guard o middleware. Si ya existe, se reutiliza y no se crea uno nuevo (§12, acción 3).

---

# 6. Entregables por módulo

Los contratos de abajo son la referencia normativa de **rutas, verbos, campos de request, status de éxito, códigos de error e idempotencia**. Los cuerpos JSON completos con ejemplos reales viven en `API-CONTRACT.md`; los dos documentos describen la misma API.

Todas las rutas cuelgan del prefijo global `/api/v1`. Todas exigen `Authorization: Bearer <jwt>`.

## 6.0 A00 — Infraestructura común

**Archivos:**

```
src/common/
  decorators/current-user.decorator.ts
  decorators/current-profile.decorator.ts
  interceptors/profile.interceptor.ts
  errors/domain.exception.ts          → DomainException (base, lleva `code`)
  errors/pg-error.ts                  → parsePgError()
  errors/prisma-error.mapper.ts       → PrismaErrorMapper.toDomainException()
  pagination/cursor.ts                → encodeCursor() / decodeCursor()
  pagination/offset.dto.ts            → OffsetQueryDto
  pagination/cursor.dto.ts            → CursorQueryDto
  validators/is-cents-string.validator.ts
  validators/is-calendar-date.validator.ts
  idempotency/idempotency-key.decorator.ts  → @IdempotencyKey() (valida y devuelve el uuid)
  prisma/prisma.module.ts             → solo si no existe ya en el repo
```

**Cambios a archivos existentes — los únicos permitidos fuera de `src/` nuevo:**

| Archivo | Cambio |
|---|---|
| `src/main.ts` | `app.setGlobalPrefix('api/v1')`. **La línea del override de `BigInt` sigue siendo la primera del archivo.** |
| `src/common/filters/global-exception.filter.ts` | Agregar el campo `code` según §5.3. No se toca nada más. |
| `package.json` | Agregar `test:integration:api`; ampliar el ignore de `test:integration:db`. Ver §12, acción 2. |

## 6.1 A01 — `AccountsDataModule` (compartido)

```
src/shared/accounts-data/
  accounts-data.module.ts
  interfaces/account-repository.interface.ts
  repositories/prisma-account.repository.ts
  types.ts
```

```ts
export interface AccountRow {
  id: string; userId: string; name: string; type: AccountType;
  currency: string; rolloverType: RolloverType | null; isSystem: boolean;
  archivedAt: Date | null; createdAt: Date; updatedAt: Date;
}

export interface IAccountRepository {
  create(userId: string, data: CreateAccountData): Promise<AccountRow>;
  findById(userId: string, id: string): Promise<AccountRow | null>;
  findManyByIds(userId: string, ids: string[]): Promise<AccountRow[]>;
  findMany(userId: string, filter: { types: AccountType[]; includeArchived: boolean; includeSystem: boolean }, page: OffsetPage): Promise<Paged<AccountRow>>;
  findSystemEquity(userId: string): Promise<AccountRow | null>;
  update(userId: string, id: string, data: UpdateAccountData): Promise<AccountRow>;
  setArchivedAt(userId: string, id: string, value: Date | null): Promise<AccountRow>;
  hasEntries(userId: string, accountId: string): Promise<boolean>;
  hasLiveAllocationsInOpenPeriods(userId: string, categoryId: string): Promise<boolean>;
  nameExists(userId: string, name: string, excludeId?: string): Promise<boolean>;
}
```

- `findManyByIds` devuelve solo las cuentas del usuario. Si el conteo devuelto es menor al de `ids`, el Service lanza el `404` correspondiente al rol de la cuenta faltante.
- `hasLiveAllocationsInOpenPeriods` existe para S-R6.
- `nameExists` es la pre-validación de `accounts_user_name_active_uniq`; la comparación es **case-insensitive** porque el índice es sobre `lower(name)`.
- **`findMany` es el único método que filtra `archived_at`** (S-R4), y solo cuando `includeArchived === false`.

## 6.2 A02 — `QueriesModule` (compartido)

```
src/shared/periods-data/
  periods-data.module.ts
  interfaces/budget-period-repository.interface.ts
  repositories/prisma-budget-period.repository.ts
  types.ts
```

Se entrega junto con A01 y por las mismas razones. `BudgetModule`, `TransactionsModule` y `RecurringModule` lo importan.

```
src/shared/queries/
  queries.module.ts
  interfaces/query-repository.interface.ts
  repositories/prisma-query.repository.ts
  types.ts
```

```ts
export interface IQueryRepository {
  accountBalances(userId: string): Promise<AccountBalanceRow[]>;                        // F1
  categoryBalances(userId: string, periodId: string): Promise<CategoryBalanceRow[]>;    // F2
  unassignedFunds(userId: string): Promise<bigint>;                                     // F3
  transactionsWithoutPeriod(userId: string): Promise<OrphanTransactionRow[]>;           // F4
}
```

- Las cuatro se invocan con `$queryRaw` tipado. **Prisma no las tipa**: los tipos de retorno se declaran a mano en `types.ts`.
- `unassignedFunds` devuelve `bigint`, no un arreglo: F3 garantiza exactamente una fila siempre (§3.9). El repository desempaqueta.
- **Ninguna de las cuatro recibe parámetros de filtrado adicionales.** No se agregan `WHERE` extra por fuera de la función.
- **`accountBalances` no filtra `archived_at` ni `is_system`.** Ese filtrado, cuando aplica, lo hace el Service consumidor (S-R4).
- Este módulo **lo importan todos los módulos de dominio**, incluido `insights` (D4).

## 6.3 A03 — `LedgerModule` (compartido)

```
src/shared/ledger/
  ledger.module.ts
  entry-builders.ts                    ⭐ funciones puras, unit tests sin DB
  entry-builders.spec.ts
  account-role.validator.ts            ⭐ función pura
  interfaces/transaction-repository.interface.ts
  repositories/prisma-transaction.repository.ts
  types.ts
  exceptions/idempotency-in-flight.exception.ts
```

```ts
export interface ITransactionRepository {
  createWithEntries(userId: string, draft: TransactionDraft, entries: EntryDraft[]): Promise<CreateTransactionResult>;
  findById(userId: string, id: string): Promise<TransactionWithEntries | null>;
  findByIdempotencyKey(userId: string, key: string): Promise<TransactionWithEntries | null>;
  findReversalOf(userId: string, transactionId: string): Promise<TransactionRow | null>;
  updateDescription(userId: string, id: string, description: string): Promise<TransactionRow>;
  findManyByCursor(userId: string, filter: TransactionFilter, cursor: TxCursor | null, limit: number): Promise<CursorPage<TransactionWithEntries>>;
  findEntriesByAccountCursor(userId: string, accountId: string, cursor: EntryCursor | null, limit: number): Promise<CursorPage<EntryWithTransaction>>;
}
```

- `updateDescription` es el **único** método de escritura sobre `transactions` fuera de `createWithEntries`. R6 permite actualizar `description` y nada más.
- **No existe ningún método `delete` ni `update` sobre `entries`.** R5 los bloquea y la interfaz no debe insinuar que son posibles.
- `findEntriesByAccountCursor` sirve tanto a `/accounts/{id}/ledger` como a `/categories/{id}/ledger`: son el mismo query, cambia solo el `type` de la cuenta que el Service validó antes.

## 6.4 A04 — módulo `profile`

```
src/profile/  → profile.module.ts · profile.controller.ts · profile.service.ts
                interfaces/profile-repository.interface.ts
                repositories/prisma-profile.repository.ts
                dto/update-profile.dto.ts · dto/profile-response.dto.ts
```

| Método | Ruta | Request | Éxito | Errores | Idem |
|---|---|---|---|---|---|
| GET | `/me` | — | `200` | `401` | no |
| PATCH | `/me` | `timezone` | `200` | `400 INVALID_TIMEZONE`, `401` | no |

`timezone` se valida contra `pg_timezone_names` con un `$queryRaw` (`SELECT 1 FROM pg_timezone_names WHERE name = $1`). No se acepta un string arbitrario.

## 6.5 A05 — módulo `accounts`

Cubre `kind ∈ { cash, credit, receivable }` (`type ∈ { asset, liability, receivable }` en la base). **Nunca** devuelve cuentas con `is_system = true`.

| Método | Ruta | Request | Éxito | Errores | Idem |
|---|---|---|---|---|---|
| GET | `/accounts` | `kind?`, `includeArchived?` (default `false`), `page?`, `pageSize?` | `200` | `400` | no |
| POST | `/accounts` | `name`, `kind`, `currency?` (default `MXN`) | `201` | `409 DUPLICATE_ACCOUNT_NAME`, `422 INVALID_INPUT` | no |
| GET | `/accounts/{id}` | — | `200` | `404 ACCOUNT_NOT_FOUND` | no |
| PATCH | `/accounts/{id}` | `name?`, `currency?` | `200` | `404`, `409 DUPLICATE_ACCOUNT_NAME`, `409 CURRENCY_LOCKED` | no |
| POST | `/accounts/{id}/archive` | — | `200` | `404`, `409 ACCOUNT_NOT_EMPTY`, `409 ALREADY_ARCHIVED` | no |
| POST | `/accounts/{id}/unarchive` | — | `200` | `404`, `409 NOT_ARCHIVED`, `409 DUPLICATE_ACCOUNT_NAME` | no |
| GET | `/accounts/{id}/ledger` | `limit?`, `cursor?` | `200` | `400 INVALID_CURSOR`, `404` | no |

- **`rolloverType` no es un campo válido en este módulo.** El constraint `accounts_rollover_consistency` lo prohíbe fuera de `expense`; el DTO ni siquiera lo declara y `forbidNonWhitelisted` lo rechaza con `400`.
- El listado incluye `balanceCents` de F1 para cada cuenta. Se resuelve con **una** llamada a `accountBalances` y un join en memoria, nunca con una query por fila.
- `PATCH` con `currency`: **S-R5**. Si `hasEntries` → `409 CURRENCY_LOCKED`.
- `unarchive` puede chocar contra el índice único parcial si mientras tanto se creó otra cuenta activa con el mismo nombre. Se pre-valida con `nameExists`.

**Orden garantizado:** `name` ascendente, `id` ascendente de desempate (`PrismaAccountRepository.findMany`, compartido con `categories`/`income-sources`). No es `createdAt`: varias cuentas creadas en la misma transacción (seeds, fixtures) comparten el mismo `now()` de Postgres, así que ordenar por ahí deja el desempate indefinido. Mismo razonamiento que el orden de `movements` en §6.7 — un cliente que pinta la lista de cuentas necesita que no baile entre cargas.

## 6.6 A06 — módulo `categories`

Cubre `kind ∈ { category, income_source }` (`type ∈ { expense, income }` en la base), con dos raíces de ruta distintas y el mismo repository.

**Sobres — `expense`:**

| Método | Ruta | Request | Éxito | Errores | Idem |
|---|---|---|---|---|---|
| GET | `/categories` | `periodId?`, `includeArchived?`, `page?`, `pageSize?` | `200` | `400`, `404 PERIOD_NOT_FOUND` | no |
| POST | `/categories` | `name`, `rolloverType`, `currency?` | `201` | `409 DUPLICATE_ACCOUNT_NAME`, `422` | no |
| GET | `/categories/{id}` | `periodId?` | `200` | `404 CATEGORY_NOT_FOUND` | no |
| PATCH | `/categories/{id}` | `name?`, `rolloverType?` | `200` | `404`, `409 DUPLICATE_ACCOUNT_NAME` | no |
| POST | `/categories/{id}/archive` | — | `200` | `404`, `409 CATEGORY_HAS_ALLOCATIONS`, `409 ALREADY_ARCHIVED` | no |
| POST | `/categories/{id}/unarchive` | — | `200` | `404`, `409 NOT_ARCHIVED`, `409 DUPLICATE_ACCOUNT_NAME` | no |
| GET | `/categories/{id}/ledger` | `limit?`, `cursor?` | `200` | `400 INVALID_CURSOR`, `404` | no |

- `rolloverType` es **obligatorio** al crear (`accounts_rollover_consistency`) y editable en cualquier momento. Cambiarlo solo afecta cierres futuros; no re-materializa nada.
- **Sin `periodId`**, la respuesta trae el gasto acumulado histórico de F1. **Con `periodId`**, agrega `assignedCents`, `spentCents`, `availableCents` y `hasBudget` de F2 para ese periodo.
- `archive` aplica **S-R6**, no R8 — R8 exime a `expense` del saldo cero y esa exención se conserva.
- **Orden garantizado** en `/categories` e `/income-sources`: `name` ascendente, `id` ascendente de desempate — mismo mecanismo que `/accounts` (§6.5), mismo repository.

**Fuentes de ingreso — `income`:**

| Método | Ruta | Request | Éxito | Errores | Idem |
|---|---|---|---|---|---|
| GET | `/income-sources` | `includeArchived?`, `page?`, `pageSize?` | `200` | `400` | no |
| POST | `/income-sources` | `name`, `currency?` | `201` | `409 DUPLICATE_ACCOUNT_NAME`, `422` | no |
| GET | `/income-sources/{id}` | — | `200` | `404 INCOME_SOURCE_NOT_FOUND` | no |
| PATCH | `/income-sources/{id}` | `name?` | `200` | `404`, `409 DUPLICATE_ACCOUNT_NAME` | no |
| POST | `/income-sources/{id}/archive` · `/unarchive` | — | `200` | `404`, `409` | no |

- `rolloverType` prohibido. R8 no aplica a `income`.
- **El nombre es único entre todas las cuentas activas del usuario**, sin importar el `type` (el índice es sobre `(user_id, lower(name))`). Un sobre "Salud" y una cuenta "Salud" **no** pueden coexistir. `API-CONTRACT.md` debe decirlo con esas palabras.

## 6.7 A07 — módulo `transactions`

| Método | Ruta | Request | Éxito | Errores | Idem |
|---|---|---|---|---|---|
| POST | `/transactions/expenses` | `bookedAt`, `description`, `paidFromAccountId`, `totalCents`, `lines[]`, `lentTo[]?` | `201`/`200` | `400`, `403`, `404`, `409`, `422` | **sí** |
| POST | `/transactions/incomes` | `bookedAt`, `description`, `toAccountId`, `sourceId`, `amountCents` | `201`/`200` | idem | **sí** |
| POST | `/transactions/transfers` | `bookedAt`, `description`, `fromAccountId`, `toAccountId`, `amountCents` | `201`/`200` | idem + `422 SAME_ACCOUNT_TRANSFER` | **sí** |
| POST | `/transactions/loans` | `bookedAt`, `description`, `fromAccountId`, `receivableAccountId`, `amountCents` | `201`/`200` | idem | **sí** |
| POST | `/transactions/loan-repayments` | `bookedAt`, `description`, `receivableAccountId`, `toAccountId`, `amountCents` | `201`/`200` | idem | **sí** |
| POST | `/transactions/loan-write-offs` | `bookedAt`, `description`, `receivableAccountId`, `categoryId`, `amountCents` | `201`/`200` | idem | **sí** |
| POST | `/transactions/opening-balances` | `bookedAt`, `description?`, `balances[]` | `201`/`200` | idem + `422 EMPTY_OPENING_BALANCE` | **sí** |
| POST | `/transactions/{id}/reversal` | `bookedAt?`, `description?` | `201`/`200` | `404`, `409 ALREADY_REVERSED`, `409 CANNOT_REVERSE_REVERSAL`, `422 REVERSAL_DATE_LOCKED` | **sí** |
| GET | `/transactions` | `from?`, `to?`, `accountId?`, `categoryId?`, `limit?`, `cursor?` | `200` | `400 INVALID_CURSOR` | no |
| GET | `/transactions/{id}` | — | `200` | `404 TRANSACTION_NOT_FOUND` | no |
| PATCH | `/transactions/{id}` | `description` | `200` | `404`, `422` | no |

**Secuencia obligatoria de cada Service de creación**, en este orden exacto:

1. Validar el DTO (lo hace `ValidationPipe` antes del controller).
2. `findManyByIds` con **todos** los `accountId` del request, en **una** llamada.
3. Verificar existencia y propiedad → `404` con el código del rol faltante.
4. Verificar `is_system === false` → `403 SYSTEM_ACCOUNT_NOT_ADDRESSABLE`.
5. Verificar `archivedAt === null` → `409 ACCOUNT_ARCHIVED` (S-R9).
6. Verificar el **rol** de cada cuenta contra la tabla de §4 → `422 INVALID_ACCOUNT_ROLE`.
7. Verificar **moneda única** → `422 MIXED_CURRENCY`.
8. Llamar al builder puro correspondiente.
9. `createWithEntries`.
10. Mapear a DTO de respuesta.

**Los pasos 3–7 son pre-validaciones.** Su objetivo es que R3, R4 y R7 **nunca** se disparen en operación normal. Si un test provoca un `ERRCODE` de trigger por el camino feliz, falta una pre-validación.

**La respuesta de creación NO devuelve movimientos.** Devuelve `{ id, bookedAt, description, totalCents, createdAt, reversesTransactionId, budgetImpact }` y nada más. Exponer los movimientos en la respuesta de creación empujaría al cliente a razonar en partida doble justo en el punto donde la capa de traducción existe para evitarlo. Si el cliente necesita el detalle, lo pide con `GET /transactions/{id}`; si lo que necesita son saldos, `GET /insights/account-balances`.

**Orden garantizado de `movements`** (`GET /transactions/{id}` y `GET /transactions`, §5.6). `entries` no tiene columna que reconstruya el orden de inserción (`id` es un UUID aleatorio; `created_at` es el mismo timestamp de transacción para todos los entries de una misma escritura) — sin una regla explícita, dos lecturas de la misma transacción podrían devolver `movements` en orden distinto. La garantía: **`amount_cents` ascendente** — primero de dónde salió el dinero (negativos), luego a dónde fue (positivos) — con **`id` ascendente** como desempate cuando dos entries comparten el mismo monto (p. ej. un split simétrico). Es una convención, no una regla de negocio: un cliente puede depender de que el orden sea estable entre lecturas, no de que tenga un significado más allá de "salida antes que entrada".

```ts
budgetImpact: {
  status: 'in_open_period' | 'no_period' | 'compensated' | 'uncompensated';
  closedPeriodId: string | null;         // el periodo cerrado que contiene bookedAt
  compensatedInPeriodId: string | null;  // el periodo abierto actual donde se aplicó
  compensations: Array<{ categoryId: string; categoryName: string; amountCents: bigint }>;
}
```

En `in_open_period` y `no_period`, los tres últimos campos vienen en `null` / `[]`.

## 6.8 A08 — módulo `budget`

> **Nota de dependencia.** `TransactionsModule` y `RecurringModule` necesitan resolver "¿qué periodo cubre esta fecha?" para §2.3, y D4 prohíbe que importen `BudgetModule`. Por eso `IBudgetPeriodRepository` y `PrismaBudgetPeriodRepository` **no viven en `budget/`, viven en `src/shared/periods-data/` (`PeriodsDataModule`)**, que `BudgetModule` también importa. Es el mismo patrón de `AccountsDataModule`: el acceso a la tabla es infraestructura compartida; la lógica de cierre y de asignación sigue siendo exclusiva de `BudgetModule`.
>
> Métodos mínimos: `findPeriodCoveringDate(userId, date)`, `findById`, `findMany`, `findNextAfter(userId, endsOn)`, `findEarliestOpenBefore(userId, startsOn)`, `create`, `updateDates`, `softDelete`, `lockForUpdate(tx, userId, id)`, `setClosedAt`.

**Periodos:**

| Método | Ruta | Request | Éxito | Errores | Idem |
|---|---|---|---|---|---|
| GET | `/periods` | `status?` (`open`\|`closed`), `page?`, `pageSize?` | `200` | `400` | no |
| GET | `/periods/current` | — | `200` | `404 NO_CURRENT_PERIOD` | no |
| POST | `/periods` | `startsOn`, `endsOn` | `201` | `409 PERIOD_OVERLAP`, `422 INVALID_INPUT` | no |
| GET | `/periods/{id}` | — | `200` | `404 PERIOD_NOT_FOUND` | no |
| PATCH | `/periods/{id}` | `startsOn?`, `endsOn?` | `200` | `404`, `409 PERIOD_CLOSED`, `409 PERIOD_OVERLAP`, `422` | no |
| DELETE | `/periods/{id}` | — | `204` | `404`, `409 PERIOD_CLOSED`, `409 PERIOD_NOT_EMPTY` | no |
| GET | `/periods/{id}/close-preview` | — | `200` | `404` | no |
| POST | `/periods/{id}/close` | — | `200` | `404`, `409 PERIOD_ALREADY_CLOSED`, `409 NEXT_PERIOD_REQUIRED`, `409 NEXT_PERIOD_CLOSED`, `409 EARLIER_PERIOD_OPEN` | no |

- `GET /periods/current`: el periodo no borrado cuyo rango contiene **hoy en `profile.timezone`**. Nunca `now()::date` de Postgres.
- `DELETE /periods/{id}` es **soft delete** y responde `204`. Precondiciones:
  1. `closed_at IS NULL`, si no → `409 PERIOD_CLOSED`. Un periodo cerrado ya materializó rollover contra el siguiente; borrarlo deja ese arrastre sin origen.
  2. Cero `budget_entries` vigentes (`deleted_at IS NULL`), de **cualquier** `source`, si no → `409 PERIOD_NOT_EMPTY`. Cubre el caso de un periodo que ya recibió rollover de uno anterior.
  3. **No bloquea por transacciones.** Borrar el periodo hace que las transacciones de ese rango aparezcan en F4, que es un estado válido y reversible creando un periodo nuevo. `API-CONTRACT.md` lo advierte.

**Algoritmo de cierre — `POST /periods/{id}/close`.** Todo dentro de un único `prisma.$transaction`:

1. `SELECT ... FROM budget_periods WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL FOR UPDATE`. Sin fila → `404`.
2. `closed_at IS NOT NULL` → `409 PERIOD_ALREADY_CLOSED`.
3. **S-R8**: existe otro periodo abierto con `starts_on` menor → `409 EARLIER_PERIOD_OPEN`.
4. Resolver **el periodo siguiente**: el del mismo usuario, no borrado, con el `starts_on` **más pequeño que sea estrictamente mayor** al `ends_on` del que se cierra. Sin resultado → `409 NEXT_PERIOD_REQUIRED` (P-01).
5. Periodo siguiente con `closed_at IS NOT NULL` → `409 NEXT_PERIOD_CLOSED` (S-R2).
6. `categoryBalances(userId, periodId)` (F2) + `rolloverType` por categoría desde `accounts` — **un query extra, la función F2 no se toca**.
7. Por cada categoría:
   - `available > 0` y `rolloverType = 'accumulate'` → insertar `budget_entry` en el **periodo siguiente**: `amount_cents = available`, `source = 'rollover'`, `note` que identifique el periodo de origen.
   - `available < 0`, **sin importar el `rolloverType`** → insertar `budget_entry` **negativo** en el periodo siguiente: `amount_cents = available`, `source = 'rollover'`, `note`. El déficit se arrastra siempre.
   - `available > 0` y `rolloverType = 'reset'` → **nada**.
   - `available === 0` → **nada**. Un entry en cero viola `budget_entries_amount_nonzero`.
8. `UPDATE budget_periods SET closed_at = now() WHERE id = $1`.
9. `COMMIT`.

La respuesta devuelve el periodo cerrado más el resumen de lo que se materializó. Una segunda ejecución concurrente choca contra `budget_entries_rollover_uniq` → `409 DUPLICATE_ROLLOVER`.

**`GET /periods/{id}/close-preview`** devuelve, por categoría: `assignedCents`, `spentCents`, `availableCents`, `hasBudget`, `rolloverType` y una `action` ∈ `carry_forward | release | carry_deficit | none`; más `nextPeriodId`, `canClose` y `blockers[]` con los mismos códigos que devolvería el `POST`. **No escribe nada.**

**Asignaciones:**

| Método | Ruta | Request | Éxito | Errores | Idem |
|---|---|---|---|---|---|
| GET | `/periods/{id}/allocations` | — | `200` | `404 PERIOD_NOT_FOUND` | no |
| POST | `/periods/{id}/allocations` | `categoryId`, `amountCents` (≠ 0), `note?` | `201` | `404`, `409 PERIOD_CLOSED`, `422 INVALID_BUDGET_CATEGORY` | no |
| PUT | `/periods/{id}/allocations/{categoryId}` | `targetAssignedCents` | `200` | `404`, `409 PERIOD_CLOSED`, `422` | no |
| POST | `/periods/{id}/allocations/move` | `fromCategoryId`, `toCategoryId`, `amountCents` (> 0) | `200` | `404`, `409 PERIOD_CLOSED`, `422 SAME_CATEGORY_MOVE` | no |
| DELETE | `/periods/{id}/allocations/{allocationId}` | — | `204` | `404 ALLOCATION_NOT_FOUND`, `409 PERIOD_CLOSED` | no |

**`PUT /periods/{id}/allocations/{categoryId}` — obligatorio implementarlo así:**

Todo dentro de un único `prisma.$transaction`, en este orden:

1. `SELECT id, closed_at FROM budget_periods WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL FOR UPDATE` — **el lock sobre la fila del periodo es lo que serializa todas las escrituras de asignación de ese periodo.**
2. `closed_at IS NOT NULL` → `409 PERIOD_CLOSED`.
3. `SELECT COALESCE(SUM(amount_cents), 0) FROM budget_entries WHERE period_id = $1 AND category_id = $3 AND deleted_at IS NULL` — **dentro de la misma transacción, después del lock.**
4. `delta = targetAssignedCents − currentAssigned`.
5. `delta === 0n` → no se inserta nada, se responde `200` con el estado actual.
6. `delta !== 0n` → insertar un `budget_entry` con `source = 'manual'` y `amount_cents = delta`.
7. `COMMIT`.

**Calcular el delta fuera de la transacción, o antes del `FOR UPDATE`, reintroduce exactamente el bug que este endpoint existe para evitar:** dos clientes que leen `assigned = 300` y fijan objetivo `500` escribirían `+200` cada uno y el resultado sería `700`. **El test T-L07 verifica esto con dos llamadas concurrentes reales y no se puede saltar.**

`POST /allocations/move` usa **el mismo lock** sobre la fila del periodo y escribe los dos `budget_entries` (`−amount` en origen, `+amount` en destino) dentro de la misma transacción.

## 6.9 A09 — módulo `recurring`

| Método | Ruta | Request | Éxito | Errores | Idem |
|---|---|---|---|---|---|
| GET | `/recurring-templates` | `dueOnly?`, `includeInactive?`, `page?`, `pageSize?` | `200` | `400` | no |
| POST | `/recurring-templates` | `name`, `categoryId`, `amountCents` (> 0), `dayOfMonth` (1–31), `accountId?`, `nextDueOn?` | `201` | `404`, `422` | no |
| GET | `/recurring-templates/{id}` | — | `200` | `404 RECURRING_TEMPLATE_NOT_FOUND` | no |
| PATCH | `/recurring-templates/{id}` | `name?`, `categoryId?`, `amountCents?`, `dayOfMonth?`, `accountId?`, `isActive?` | `200` | `404`, `422` | no |
| DELETE | `/recurring-templates/{id}` | — | `204` | `404` | no |
| POST | `/recurring-templates/{id}/confirm` | `bookedAt?`, `amountCents?`, `paidFromAccountId?`, `description?` | `201`/`200` | `404`, `409`, `422` | **sí** |

- `dueOnly=true` filtra `next_due_on <= hoy` calculado con `profile.timezone`.
- **`confirm`** es una intención de gasto completa: los campos del body **sobreescriben** los del template (monto real distinto del estimado, cuenta real distinta de la sugerida). Defaults: `bookedAt` = hoy en `profile.timezone`; `amountCents` = `template.amountCents`; `paidFromAccountId` = `template.accountId`; `description` = `template.name`.
- Si `paidFromAccountId` queda sin resolver (ni body ni template) → `422 PAYMENT_ACCOUNT_REQUIRED`.
- `confirm` usa **el mismo `buildExpenseEntries`** que `/transactions/expenses` y el mismo `ITransactionRepository.createWithEntries`. **No duplica la traducción ni importa `TransactionsModule`** (D4).
- Tras crear la transacción, en **la misma transacción de base de datos**: `last_confirmed_on = bookedAt` y `next_due_on = nextDueOn(dayOfMonth, lastConfirmedOn)` usando la función pura de U08b. **No se reimplementa esa regla aquí.**
- En una respuesta `200` por idempotencia, **el template no se avanza dos veces**: el avance ocurre solo cuando `createWithEntries` devuelve `created: true`.
- **Hereda la compensación de captura tardía de §2.3 sin código propio**: usa la misma secuencia de resolución del paso 9 de §6.7 y el mismo `buildBudgetCompensations`. El bloque `budgetImpact` viaja dentro de `transaction` en la respuesta.
- **No existe `/skip`.** Fuera de alcance.

## 6.10 A10 — módulo `insights`

| Método | Ruta | Request | Éxito | Errores | Idem |
|---|---|---|---|---|---|
| GET | `/insights/account-balances` | — | `200` | `401` | no |
| GET | `/insights/category-balances` | `periodId` (obligatorio) | `200` | `400`, `404 PERIOD_NOT_FOUND` | no |
| GET | `/insights/unassigned-funds` | — | `200` | `401` | no |
| GET | `/insights/unbudgeted-transactions` | — | `200` | `401` | no |
| GET | `/insights/dashboard` | `periodId?` | `200` | `404 PERIOD_NOT_FOUND` (solo con `periodId` explícito e inválido) | no |

- `account-balances` devuelve **todas** las cuentas, incluidas archivadas, **excepto** las `is_system` — el ancla de `equity` nunca se muestra al usuario (§3.2). Cada fila incluye `kind` para que el cliente aplique la regla de presentación de signo de §5.6. **Orden garantizado:** `name` ascendente, `id` de desempate — la lista de cuentas sale de `PrismaAccountRepository.findMany`, mismo mecanismo que `/accounts` (§6.5); `dashboard.accounts` hereda el mismo orden porque compone sobre `accountBalances`.
- `unbudgeted-transactions` es F4 sin paginación: la lista es por definición corta y F4 ya trae `description` para no requerir una query por fila.
- `dashboard` es una **composición**, no una función nueva: `accountBalances` + `unassignedFunds` + `transactionsWithoutPeriod` + (`categoryBalances` si vino `periodId`, o el periodo actual resuelto por `profile.timezone` si no vino). Existe porque la pantalla principal necesita las cuatro y cuatro round-trips en un arranque serverless en frío se notan.
- **El `404 PERIOD_NOT_FOUND` de la fila de arriba es solo para `periodId` explícito que no resuelve** (mismo caso que `category-balances`). **Sin `periodId` y sin ningún periodo que cubra hoy, NO es un error** — `dashboard` responde `200` con `period: null` y `categories: []`; el resto de los bloques (`accounts`, `unassignedCents`, `unbudgetedTransactions`) se calcula igual, sin depender de que exista un periodo (API-CONTRACT.md §14, línea 1340). Es el estado de cualquier usuario recién creado — confundir estos dos casos rompió `dashboard` en producción una vez (ver PROGRESS.md, T-O16); no repetirlo.
- **`insights` no calcula nada.** Toda la aritmética vive en F1–F4. Este módulo mapea y compone.

## 6.11 A11 — verificación de contrato

Sin código de dominio. Solo la suite de §10, grupo R.

---

# 7. Orden de ejecución — grafo de dependencias

El orden **no es una preferencia**. Cada arista existe porque la unidad destino no se puede escribir ni verificar sin la origen.

```
╔══════════════════ LOOP 1 — infraestructura y catálogo ══════════════════╗
║                                                                          ║
║  A00  Infraestructura común                                              ║
║        │  (decoradores, DomainException, parsePgError, cursor,           ║
║        │   validadores, ProfileInterceptor, /api/v1, `code` en el filtro) ║
║        ├──────────────┬──────────────┬──────────────┐                    ║
║        ▼              ▼              ▼              ▼                    ║
║   A01 AccountsData  A01b Periods   A02 Queries   A04 profile             ║
║        │             Data            │                                   ║
║        └──────┬───────┘              │                                   ║
║               ▼                      │                                   ║
║          A03 Ledger                  │                                   ║
║      (builders puros +               │                                   ║
║       compensaciones +               │                                   ║
║       ITransactionRepository)        │                                   ║
║                       ┌──────────────┴──────────────┐                    ║
║                       ▼                             ▼                    ║
║                 A05 accounts                  A06 categories             ║
║                                                                          ║
╚══════════════════════════════════════════════════════════════════════════╝
                                   │
                                   ▼   (loop 1 cerrado y en verde)
╔═══════════════════════════ LOOP 2 — dominio ════════════════════════════╗
║                                                                          ║
║        ┌──────────────┬──────────────┬──────────────┐                    ║
║        ▼              ▼              ▼              ▼                    ║
║   A07 transactions  A08 budget   A10 insights   (A09 espera a A07)       ║
║        │                                                                 ║
║        ▼                                                                 ║
║   A09 recurring                                                          ║
║        │                                                                 ║
║        ▼                                                                 ║
║   A11 Verificación de contrato (toda la API montada)                     ║
║                                                                          ║
╚══════════════════════════════════════════════════════════════════════════╝
```

**`A01b PeriodsDataModule`** es la unidad que se agregó al partir `IBudgetPeriodRepository` fuera de `BudgetModule` (§6.8). Vive en el loop 1 porque A03 y A07 la necesitan para resolver la compensación de captura tardía.

**Aristas y qué se rompe si se adelanta:**

| Arista | Por qué |
|---|---|
| A00 → todo | Sin `DomainException` ni el campo `code`, ningún test de error puede afirmar nada. Sin el prefijo global, todas las rutas de todos los tests están mal. |
| A01 → A03 | Los builders son puros, pero el Service que los rodea valida roles con `findManyByIds`. Sin el repository no hay validación de rol que testear. |
| A01b → A03, A07, A09 | La compensación de §2.3 necesita `findPeriodCoveringDate` para saber si `bookedAt` cae en un periodo cerrado y cuál es el periodo abierto actual. |
| A03 → A07, A09 | `createWithEntries` es el único camino de escritura de ledger (S-R1) y el único lugar donde se escriben compensaciones. |
| A02 → A05, A06, A08, A10 | Los saldos de F1/F2 aparecen en las respuestas de listado de cuentas y sobres, y el cierre necesita F2. |
| A00 → A04 | `/periods/current`, `dueOnly`, los defaults de `confirm` y la resolución del periodo actual de §2.3 dependen de `profile.timezone`. |
| A08 → nada de A07 | El cierre **no** escribe ledger. Son módulos independientes; si el agente encuentra que necesita `TransactionsService` en `budget`, se equivocó de diseño. |
| A09 después de A07 | No por dependencia de código (D4 lo prohíbe) sino de verificación: los tests de `confirm` reusan las afirmaciones ya escritas para `/transactions/expenses`. |

**Dentro del loop 1**, A01, A01b, A02 y A04 pueden trabajarse en paralelo; A05 y A06 también, una vez cerradas A01 y A02.
**Dentro del loop 2**, A07, A08 y A10 pueden trabajarse en paralelo.

**Qué se verifica de A03 en el loop 1.** El repository invocado directamente (`createWithEntries`, idempotencia, compensaciones) y los builders puros. **No** los endpoints: esos son A07 y viven en el loop 2. Es lo que permite cerrar el loop 1 sin que exista ni un controller de transacciones.

---

# 8. Qué NO debe hacer el agente

Prohibiciones duras. Violar cualquiera invalida la tarea aunque los tests estén en verde.

## 8.1 Siguen vigentes de `TASK-db.md` y `TASK-auth.md`

- **No ejecutar `prisma db push`, `prisma migrate dev` (ni con `--create-only`), ni `prisma migrate diff`.**
- **No crear objetos desde la UI de Supabase.**
- **No editar migraciones ya aplicadas.**
- **No declarar `multiSchema` ni ningún modelo de Prisma para `auth.users`.**
- **No modificar `ARCHITECTURE.md`.** Es entrada, no salida.
- **No convertir F1–F4 en vistas, ni "simplificar" F3**, ni acotarla a un periodo, ni colapsar la agregación por par `(categoría, periodo abierto)`.
- **No agregar `deleted_at` a `transactions` ni a `entries`.**
- **No abrirle excepciones a R5 ni a R11.**
- **No agregar `ON DELETE CASCADE` a ninguna FK hacia `profiles`.**
- **No filtrar `archived_at` dentro de ninguna función de consulta.**
- **No introducir ninguna columna ni campo calculado de saldo persistido.**
- **No usar `numeric`, `decimal`, `float`, `real` ni `double precision` para montos, en ningún punto** — tampoco en un DTO ni en un tipo de TypeScript. Los montos son `bigint` o string.
- **No renombrar ni cambiar las firmas de las formas fijadas de `TASK-auth`**: `EnsureProfileExistsService.ensure`, `ProfileDeletedException`, `ErrorLogRepository.write`, los claims del JWT.
- **No hacer que `ErrorLogRepository.write()` absorba sus propios errores.**
- **No agregar trigger de `updated_at` en ninguna tabla.**
- **No implementar `McpConnection`, flujo OAuth del MCP, ni rate limiting.**
- **No escribir tests de RLS.**
- **No modificar, borrar, saltar ni comentar un test para cerrar una unidad.**
- **No escribir tests de rechazo con `expect(...).toThrow()` genérico.** Se verifica el código exacto y el estado intacto.
- **No mover ni renombrar los archivos de test existentes.**
- **No tocar código de frontend.**

## 8.2 Nuevas de esta capa

- **No crear ninguna migración.** Cero. Si el diseño de la API parece necesitar una columna, un índice o una función nueva, es un hueco de la capa de datos → §8.4, y **la capa de datos está cerrada**.
- **No exponer ningún endpoint que reciba un arreglo de entries**, ni un campo `entries` de entrada, ni `debit`/`credit`, ni un `amountCents` con signo controlado por el cliente en un endpoint de intención. El signo lo pone el builder. (`opening-balances` es la única excepción y su signo es el saldo natural declarado, no una dirección contable.)
- **No importar `PrismaClient` desde ningún Service ni Controller.** Solo los repositories lo conocen.
- **No importar un módulo de dominio desde otro módulo de dominio** (D4). Verificado por T-R05.
- **No crear un `EntriesController` ni ninguna ruta bajo `/entries`.**
- **No crear `POST /periods/{id}/reopen`** ni ningún equivalente que ponga `closed_at = NULL`. P-02 está fuera de alcance.
- **No implementar reintento, `sleep`, backoff ni polling** en la carrera de idempotencia. P-04 se decidió como `409` (§2.2).
- **No crear la categoría "Pérdidas" ni buscarla por nombre.** P-03 sigue abierto.
- **No calcular saldos ni disponibles en TypeScript.** F1–F4 son la única aritmética. Un `reduce` que sume montos en un Service es una violación, salvo la verificación de suma-cero de los builders.
- **No usar `now()` de Postgres ni `new Date()` del servidor para decidir "hoy" del usuario.** Siempre `profile.timezone`.
- **No crear un segundo exception filter, un interceptor de errores paralelo, ni cambiar los cuatro campos existentes de la respuesta de error.**
- **No agregar un campo `userId` a ningún DTO de entrada.**
- **No usar `prisma.$queryRawUnsafe` con interpolación de strings.** Parámetros posicionales siempre.
- **No devolver montos como `number` en ningún punto**, ni siquiera en un endpoint de conteo o de resumen.
- **No escribir el compensatorio de captura tardía en una transacción de base de datos separada** de la escritura de ledger (§2.3). La ventana de carrera es una consecuencia asumida, no un problema a "arreglar" partiendo la atomicidad.
- **No escribir compensatorios en la rama de recuperación por idempotencia.** Solo cuando `created === true`.
- **No inventar un caso especial de compensación para las reversas.** La inversión de signo de §4.8 lo produce sola.
- **No implementar el test de concurrencia T-L07 con dos `it()` separados** — la suite corre con `--runInBand`. La concurrencia se simula dentro de un solo test con `Promise.all` sobre conexiones distintas.

## 8.3 PENDIENTES que siguen prohibidos

| # | PENDIENTE | Estado |
|---|---|---|
| P-01 | Cierre sin periodo siguiente | ✅ **resuelto en §2.2** — `409 NEXT_PERIOD_REQUIRED` |
| P-02 | Algoritmo de reapertura | ✅ **decidido: fuera de alcance v1** — no implementar |
| P-03 | Categoría "Pérdidas" | ❌ **abierto** — no sembrar, no buscar por nombre, no crear |
| P-04 | Carrera de idempotencia | ✅ **resuelto en §2.2** — `409 IDEMPOTENCY_IN_FLIGHT` |
| P-05 | Default de `profiles.timezone` | ✅ **resuelto** — `'America/Mexico_City'`, ya en la migración |
| P-06 | `profiles.deleted_at` | ❌ **abierto en cuanto a reactivación** — el comportamiento sigue siendo `ProfileDeletedException` (403). No implementar reactivación |
| P-07 | Garantía de creación de `profiles` | ✅ **cubierto** — `EnsureProfileExistsService` vía `ProfileInterceptor` |
| P-08 | Multi-moneda | ❌ **diferido** — la validación de moneda única se pre-valida y punto |
| P-09 | Tools del MCP | ❌ **diferido** |
| P-10 | Tests de Service | ✅ **esta tarea los entrega** |
| P-11 | Cache | ❌ **diferido** |

## 8.4 Qué hacer al toparse con una decisión no documentada

**Detenerse y preguntar. No elegir.**

1. **No implementar nada** de la parte ambigua.
2. Dejar la unidad en curso **sin cerrar**. Los tests que dependan de la decisión quedan en rojo; no se borran ni se saltan.
3. Emitir este bloque y **terminar el turno**:

```
🛑 DECISIÓN REQUERIDA

Unidad: A__
Punto: <qué hay que decidir, en una frase>
Referencia: ARCHITECTURE.md §___ / TASK-api.md §___
Bloquea: <qué tests o unidades quedan detenidos>
Opciones que veo: (a) ... (b) ...
Recomendación: <cuál y por qué — pero NO la apliques>
```

4. **No continuar con otras unidades** si la decisión afecta el orden del grafo. Si es una hoja, se puede seguir con unidades independientes dejando registro de la pausa.

**Señales de que estás ante una decisión, no ante una implementación:**

- El documento dice PENDIENTE, "falta decidir" o "requiere decisión explícita".
- `ARCHITECTURE.md` y este documento parecen contradecirse.
- Un test parece estar mal escrito o pedir algo imposible.
- La implementación "obvia" requiere una columna, índice o función que no existe en §3.3 o §3.9.
- Un endpoint parece necesitar reabrir un periodo cerrado.

**Caso especial — hueco en la capa de datos.** Si el diseño de la API revela que falta algo en la base: **no agregarlo**. Registrarlo en el bloque de arriba con `Punto: hueco en la capa de datos` y terminar el turno. La capa de datos está cerrada y en verde; cualquier cambio ahí es una decisión aparte.

---

# 9. Tabla de errores

## 9.1 Nuevos códigos de dominio

Todas las excepciones extienden `DomainException`, que lleva `code` y el status HTTP. **Los nombres son normativos: no se inventan por archivo.**

| `code` | Excepción | HTTP | Cuándo |
|---|---|---|---|
| `IDEMPOTENCY_KEY_REQUIRED` | `MissingIdempotencyKeyException` | 400 | Falta el header en un endpoint que lo exige |
| `IDEMPOTENCY_KEY_INVALID` | `InvalidIdempotencyKeyException` | 400 | El header no es un UUID |
| `IDEMPOTENCY_IN_FLIGHT` | `IdempotencyInFlightException` | 409 | Conflicto detectado, fila aún no visible. Header `Retry-After: 1` |
| `INVALID_CURSOR` | `InvalidCursorException` | 400 | Cursor no decodificable |
| `VALIDATION_FAILED` | (`ValidationPipe`) | 400 | DTO inválido o con campos no declarados |
| `INVALID_TIMEZONE` | `InvalidTimezoneException` | 400 | El string no existe en `pg_timezone_names` |
| `SYSTEM_ACCOUNT_NOT_ADDRESSABLE` | `SystemAccountException` | 403 | Un `accountId` apunta a una cuenta `is_system = true` |
| `ACCOUNT_NOT_FOUND` | `AccountNotFoundException` | 404 | |
| `CATEGORY_NOT_FOUND` | `CategoryNotFoundException` | 404 | |
| `INCOME_SOURCE_NOT_FOUND` | `IncomeSourceNotFoundException` | 404 | |
| `TRANSACTION_NOT_FOUND` | `TransactionNotFoundException` | 404 | |
| `PERIOD_NOT_FOUND` | `PeriodNotFoundException` | 404 | |
| `ALLOCATION_NOT_FOUND` | `AllocationNotFoundException` | 404 | |
| `RECURRING_TEMPLATE_NOT_FOUND` | `RecurringTemplateNotFoundException` | 404 | |
| `NO_CURRENT_PERIOD` | `NoCurrentPeriodException` | 404 | Ningún periodo cubre hoy |
| `ACCOUNT_ARCHIVED` | `ArchivedAccountException` | 409 | S-R9 |
| `ALREADY_ARCHIVED` / `NOT_ARCHIVED` | `ArchiveStateException` | 409 | Archivar lo archivado / desarchivar lo activo |
| `CURRENCY_LOCKED` | `CurrencyLockedException` | 409 | S-R5 |
| `CATEGORY_HAS_ALLOCATIONS` | `CategoryHasAllocationsException` | 409 | S-R6 |
| `ALREADY_REVERSED` | `InvalidReversalException` | 409 | Ya existe una reversa de esa transacción |
| `CANNOT_REVERSE_REVERSAL` | `InvalidReversalException` | 409 | S-R7 |
| `PERIOD_CLOSED` | `ClosedPeriodException` | 409 | Escritura sobre un periodo cerrado |
| `PERIOD_ALREADY_CLOSED` | `ClosedPeriodException` | 409 | Doble cierre |
| `NEXT_PERIOD_REQUIRED` | `NextPeriodRequiredException` | 409 | P-01 |
| `NEXT_PERIOD_CLOSED` | `ClosedPeriodException` | 409 | S-R2 |
| `EARLIER_PERIOD_OPEN` | `EarlierPeriodOpenException` | 409 | S-R8 |
| `PERIOD_NOT_EMPTY` | `PeriodNotEmptyException` | 409 | Borrar un periodo con asignaciones vigentes |
| `INVALID_ACCOUNT_ROLE` | `InvalidAccountRoleException` | 422 | El `type` de la cuenta no corresponde a su rol en el request |
| `SPLIT_TOTAL_MISMATCH` | `SplitMismatchException` | 422 | `sum(lines) + sum(lentTo) ≠ totalCents` |
| `SAME_ACCOUNT_TRANSFER` | `SameAccountException` | 422 | `fromAccountId === toAccountId` |
| `SAME_CATEGORY_MOVE` | `SameAccountException` | 422 | `fromCategoryId === toCategoryId` |
| `EMPTY_OPENING_BALANCE` | `EmptyOpeningBalanceException` | 422 | Cero saldos distintos de cero |
| `PAYMENT_ACCOUNT_REQUIRED` | `PaymentAccountRequiredException` | 422 | `confirm` sin cuenta ni en el body ni en el template |
| `REVERSAL_DATE_LOCKED` | `ReversalDateLockedException` | 422 | Se mandó `bookedAt` al revertir una transacción que generó compensatorio de captura tardía. Omitirlo es el camino correcto |
| `INTERNAL_ERROR` | — | 500 | Cualquier error no controlado |

## 9.2 Mapeo desde Postgres — extiende §6 de `TASK-db.md`

La tabla de `TASK-db.md` §6 se conserva **íntegra**. Esta capa la implementa y agrega la columna `code`:

| SQLSTATE / constraint | Excepción | HTTP | `code` |
|---|---|---|---|
| `P1001`, `P1002` | `UnbalancedTransactionException` | 422 | `UNBALANCED_TRANSACTION` |
| `P1003` | `OwnershipMismatchException` | 403 | `OWNERSHIP_MISMATCH` |
| `P1004` | `MixedCurrencyException` | 422 | `MIXED_CURRENCY` |
| `P1005`, `P1006` | `ImmutableLedgerException` | 409 | `IMMUTABLE_LEDGER` |
| `P1007` | `InvalidBudgetCategoryException` | 422 | `INVALID_BUDGET_CATEGORY` |
| `P1008` | `AccountNotEmptyException` | 409 | `ACCOUNT_NOT_EMPTY` |
| `P1009` | `InvalidReversalException` | 422 | `INVALID_REVERSAL` |
| `P1010`, `P1011` | `ClosedPeriodException` | 409 | `PERIOD_CLOSED` |
| `23P01` | `PeriodOverlapException` | 409 | `PERIOD_OVERLAP` |
| `23505` · `transactions_idempotency_uniq` | **no es error** — recuperación, `200` | 200 | — |
| `23505` · `transactions_reverses_uniq` | `InvalidReversalException` | 409 | `ALREADY_REVERSED` |
| `23505` · `accounts_user_name_active_uniq` | `DuplicateAccountNameException` | 409 | `DUPLICATE_ACCOUNT_NAME` |
| `23505` · `budget_entries_rollover_uniq` | `DuplicateRolloverException` | 409 | `DUPLICATE_ROLLOVER` |
| `23503` | `ResourceInUseException` | 409 | `RESOURCE_IN_USE` |
| `23514` | `InvalidInputException` | 422 | `INVALID_INPUT` |
| `25P02` | `InternalServerErrorException` | 500 | `INTERNAL_ERROR` — **nunca debería llegar** |

## 9.3 Heredado de `TASK-auth.md`

| Situación | Excepción | HTTP | `code` |
|---|---|---|---|
| Sin token / inválido / expirado | `UnauthorizedException` | 401 | `UNAUTHORIZED` |
| `profiles.deleted_at` no nulo | `ProfileDeletedException` | 403 | `PROFILE_DELETED` |
| Sin permiso para la acción | `ForbiddenException` | 403 | `FORBIDDEN` |

---

# 10. Criterios de aceptación

Formato dado-cuando-entonces. Se verifican por los tests de §11.

| # | Dado | Cuando | Entonces |
|---|---|---|---|
| CA-01 | Un usuario autenticado con cuenta `TDC` (`liability`) y sobre `Wifi` | `POST /transactions/expenses` con `paidFromAccountId=TDC`, `totalCents="70000"`, `lines=[{Wifi,"70000"}]` | `201`, la transacción existe con exactamente 2 entries: `TDC −70000` y `Wifi +70000`, y suman cero |
| CA-02 | La misma petición y **la misma** `Idempotency-Key` | Se repite | `200`, mismo `transaction.id`, y `SELECT count(*) FROM transactions` no cambió |
| CA-03 | Un `expense` como `paidFromAccountId` | `POST /transactions/expenses` | `422 INVALID_ACCOUNT_ROLE`, cero filas escritas, **ningún trigger disparado** |
| CA-04 | Cuentas en `MXN` y `USD` en la misma intención | Cualquier `POST /transactions/*` | `422 MIXED_CURRENCY` **antes** de tocar la base |
| CA-05 | Una transacción registrada | `POST /transactions/{id}/reversal` | `201`, entries con signos exactamente invertidos, `reversesTransactionId` apuntando al original |
| CA-06 | Una transacción que ya tiene reversa | `POST /transactions/{id}/reversal` | `409 ALREADY_REVERSED` |
| CA-07 | Una transacción que **es** una reversa | `POST /transactions/{id}/reversal` | `409 CANNOT_REVERSE_REVERSAL` |
| CA-08 | Cuenta `asset` con saldo ≠ 0 | `POST /accounts/{id}/archive` | `409 ACCOUNT_NOT_EMPTY` |
| CA-09 | Sobre con gasto acumulado y **sin** asignaciones en periodos abiertos | `POST /categories/{id}/archive` | `200` — R8 exime a `expense` y S-R6 no aplica |
| CA-10 | Sobre con una asignación vigente en un periodo abierto | `POST /categories/{id}/archive` | `409 CATEGORY_HAS_ALLOCATIONS` |
| CA-11 | Cuenta con entries | `PATCH /accounts/{id}` con `currency` distinta | `409 CURRENCY_LOCKED` |
| CA-12 | Periodo abierto, `assigned=300000`, dos clientes concurrentes | Ambos `PUT /allocations/{cat}` con `targetAssignedCents="500000"` | El asignado final es **exactamente** `500000`, no `700000` |
| CA-13 | Periodo 1 abierto, periodo 2 abierto, `Comida` `accumulate` con `available=+150000` | `POST /periods/1/close` | `200`, existe un `budget_entry` `source='rollover'` de `+150000` en el periodo 2, y `periodo1.closedAt` no es nulo |
| CA-14 | `Salud` `reset` con `available=−30000` en el periodo 1 | `POST /periods/1/close` | Existe un `budget_entry` `source='rollover'` de `−30000` en el periodo 2 — el déficit se arrastra aunque sea `reset` |
| CA-15 | `Comida` `reset` con `available=+150000` | `POST /periods/1/close` | **No** existe ningún `budget_entry` de rollover para `Comida` en el periodo 2 |
| CA-16 | No existe periodo siguiente | `POST /periods/{id}/close` | `409 NEXT_PERIOD_REQUIRED`, `closedAt` sigue nulo |
| CA-17 | El periodo siguiente está cerrado | `POST /periods/{id}/close` | `409 NEXT_PERIOD_CLOSED` |
| CA-18 | Existe un periodo abierto anterior | `POST /periods/{id}/close` | `409 EARLIER_PERIOD_OPEN` |
| CA-19 | Periodo cerrado | `POST /periods/{id}/allocations` | `409 PERIOD_CLOSED`, cero filas escritas |
| CA-20 | Periodo con asignaciones vigentes | `DELETE /periods/{id}` | `409 PERIOD_NOT_EMPTY` |
| CA-21 | Cash 10000.00, un periodo abierto, `Comida` asignado 2000.00 gastado 500.00, `Salud` gastado 300.00 sin presupuesto | `GET /insights/unassigned-funds` | `{"unassignedCents":"740000"}` |
| CA-22 | Un template con `dayOfMonth=31` y `lastConfirmedOn=2026-01-31` | `POST /recurring-templates/{id}/confirm` el 1 de marzo | La transacción se crea, `nextDueOn` queda en `2026-03-31` |
| CA-23 | El mismo `confirm` repetido con la misma `Idempotency-Key` | Se repite | `200`, **una sola** transacción y `nextDueOn` **no** avanzó dos veces |
| CA-24 | Cualquier respuesta con montos | Se inspecciona el JSON crudo | Todo monto es un **string**; no existe ningún `number` de monto en ninguna respuesta |
| CA-25 | Un DTO con un campo no declarado | Cualquier `POST` | `400 VALIDATION_FAILED` con `details` |
| CA-26 | Un request sin `Authorization` | Cualquier ruta bajo `/api/v1` | `401 UNAUTHORIZED` |
| CA-27 | Un `accountId` de otro usuario | Cualquier operación | `404`, nunca `403` ni fuga de existencia |
| CA-28 | La suite completa | `npx prisma migrate status` | `Database schema is up to date!` — cero migraciones nuevas |
| CA-29 | `P1 = 1–15 ago` cerrado, `P2 = 16–31 ago` abierto, hoy 20 de agosto | `POST /transactions/expenses` de `"50000"` en `Comida` con `bookedAt="2026-08-12"` | `201`; existe en `P2` un `budget_entry` `manual` de `−50000` contra `Comida`; `budgetImpact.status="compensated"` |
| CA-30 | El mismo escenario **sin** ningún periodo abierto que cubra hoy | La misma petición | `201`; **cero** `budget_entries` nuevos; `budgetImpact.status="uncompensated"`. **La transacción nunca se rechaza por esto** |
| CA-31 | Tras CA-29 | `POST /transactions/{id}/reversal` sin `bookedAt` | `201`; existe un segundo `budget_entry` de `+50000` en `P2`; el neto de los dos es cero |
| CA-32 | Tras CA-29 | `GET /periods/P2/allocations` | El compensatorio aparece, con `source:"manual"` y una `note` que referencia la transacción de origen |
| CA-33 | Gasto tardío repartido entre `Comida` y `Salud` | `POST /transactions/expenses` con dos `lines` | **Dos** compensatorios, uno por categoría, cada uno por su monto |

---

# 11. Tests requeridos antes de implementar

Son **el criterio de verificación del loop**. Cada uno especifica entrada concreta y resultado esperado.

**Convención obligatoria para todo test marcado ❌ (debe fallar):**

1. Verificar el **`code` exacto** y el **status exacto**. Nunca `expect(...).rejects.toThrow()` pelón.
2. Verificar que **no quedó nada escrito**: `SELECT count(*)` sobre las tablas afectadas, antes y después, idénticos.

Un test que solo comprueba que "algo tronó" **no cumple** y la unidad no se cierra.

## 11.0 Qué grupo va en qué loop y en qué archivo

El filtro de los scripts es **por carpeta**, no por nombre de archivo. Cada grupo tiene un destino fijo:

| Grupo | Loop | Archivo |
|---|---|---|
| **U** — unitarios puros | 1 | junto al código (`src/**/*.spec.ts`), recogidos por `test:unit` |
| **A-core** — idempotencia y compensación a nivel de repository | 1 | `test/integration/api/core/ledger-repository.integration.spec.ts` |
| **G** — cuentas | 1 | `test/integration/api/core/accounts.integration.spec.ts` |
| **H** — sobres y fuentes de ingreso | 1 | `test/integration/api/core/categories.integration.spec.ts` |
| **P** — perfil | 1 | `test/integration/api/core/profile.integration.spec.ts` |
| **Q** — errores y mapeo | 1 | `test/integration/api/core/errors.integration.spec.ts` |
| **O-core** — F1–F4 a nivel de repository | 1 | `test/integration/api/core/queries-repository.integration.spec.ts` |
| **R-core** — contrato estático y estructural | 1 | `test/integration/api/core/contract-static.integration.spec.ts` |
| **A-http** — idempotencia a nivel de header | 2 | `test/integration/api/domain/idempotency-http.integration.spec.ts` |
| **B** — gasto | 2 | `test/integration/api/domain/transactions-expense.integration.spec.ts` |
| **C** — ingreso y transferencia | 2 | `test/integration/api/domain/transactions-income-transfer.integration.spec.ts` |
| **D** — préstamos | 2 | `test/integration/api/domain/transactions-loans.integration.spec.ts` |
| **E** — saldo inicial | 2 | `test/integration/api/domain/transactions-opening-balance.integration.spec.ts` |
| **F** — reversa | 2 | `test/integration/api/domain/transactions-reversal.integration.spec.ts` |
| **I** — consulta y paginación | 2 | `test/integration/api/domain/transactions-query.integration.spec.ts` |
| **K** — periodos | 2 | `test/integration/api/domain/periods.integration.spec.ts` |
| **L** — asignaciones | 2 | `test/integration/api/domain/allocations.integration.spec.ts` |
| **M** — cierre | 2 | `test/integration/api/domain/period-close.integration.spec.ts` |
| **N** — recurrentes | 2 | `test/integration/api/domain/recurring.integration.spec.ts` |
| **O** — insights por HTTP | 2 | `test/integration/api/domain/insights.integration.spec.ts` |
| **S** — captura tardía | 2 | `test/integration/api/domain/late-capture.integration.spec.ts` |
| **R** — contrato contra fixtures | 2 | `test/integration/api/domain/contract-fixtures.integration.spec.ts` |

**Un archivo de test no puede vivir en las dos carpetas.** Si un grupo necesita afirmar algo en los dos loops, se parte en dos archivos, como pasa con A y con O.

**Fixture base de cada test de integración** (se construye con el helper existente de `test/setup/fixture.ts`, extendido, nunca reemplazado):

- Usuario `U1` con `auth.users` + `profiles` (`timezone = 'America/Mexico_City'`) y los seeds de §3.12: 7 sobres, `Sueldo` (`income`), `Saldo Inicial` (`equity`, `is_system`).
- Usuario `U2` idéntico, para los tests de aislamiento.
- Cuentas creadas por test: `Nu` (`asset`), `TDC` (`liability`), `Efectivo` (`asset`), `PorCobrar:Fer` (`receivable`).
- Los tests de HTTP usan una app de Nest completa (`Test.createTestingModule` + `app.init()`), con `AuthGuard` real y un JWT firmado con el mismo secret de `.env.test`. **No se mockea `AuthGuard`.**

## Grupo U — unitarios puros ⭐ *sin base de datos, viven en `test:unit`*

| ID | Entrada | Esperado |
|---|---|---|
| T-U01 | `buildExpenseEntries({paidFrom:'A', total:70000n, lines:[{cat:'W',70000n}]})` | 2 entries: `A −70000n`, `W +70000n`; suma `0n` |
| T-U02 | `buildExpenseEntries` con `total:80000n`, `lines:[{C,40000n}]`, `lentTo:[{F,40000n}]` | 3 entries; suma `0n` |
| T-U03 ❌ | Igual pero `total:80000n` y partes que suman `70000n` | Lanza `SplitMismatchException` (`SPLIT_TOTAL_MISMATCH`) |
| T-U04 ❌ | `lines:[{C, 0n}]` | Lanza `InvalidInputException`; ningún entry en cero jamás sale de un builder |
| T-U05 | Mismo `categoryId` dos veces en `lines` (`30000n` + `40000n`, total `70000n`) | 3 entries, **no colapsados**; suma `0n` |
| T-U06 | `buildIncomeEntries({to:'Nu', source:'S', amount:1000000n})` | `Nu +1000000n`, `S −1000000n` |
| T-U07 | `buildTransferEntries({from:'Nu', to:'TDC', amount:70000n})` | `Nu −70000n`, `TDC +70000n` |
| T-U08 ❌ | `buildTransferEntries` con `from === to` | `SAME_ACCOUNT_TRANSFER` |
| T-U09 | `buildLoanEntries({from:'Nu', receivable:'F', amount:50000n})` | `Nu −50000n`, `F +50000n` |
| T-U10 | `buildLoanRepaymentEntries({receivable:'F', to:'Nu', amount:50000n})` | `Nu +50000n`, `F −50000n` |
| T-U11 | `buildLoanWriteOffEntries({receivable:'F', category:'P', amount:50000n})` | `F −50000n`, `P +50000n` |
| T-U12 | `buildOpeningBalanceEntries` con `[{Nu,+1000000n},{TDC,−250000n},{Ef,+80000n}]`, equity `E` | 4 entries; el de `E` es `−830000n`; suma `0n` |
| T-U13 | Balances `[{Nu,+1000n},{TDC,−1000n}]` | **2** entries; **sin** entry de equity (residual `0n`) |
| T-U14 | Balances `[{Nu,+1000n},{Ef,0n}]` | 2 entries: `Nu +1000n`, `E −1000n`. El saldo en cero se descarta |
| T-U15 ❌ | Balances `[{Nu,0n}]` | `EMPTY_OPENING_BALANCE` |
| T-U16 | `buildReversalEntries([{A,−70000n},{W,+70000n}])` | `[{A,+70000n},{W,−70000n}]`; magnitud positiva idéntica a la del original |
| T-U17 | `encodeCursor` → `decodeCursor` de `{b:'2026-08-09', t:'<uuid>'}` | Round-trip idéntico |
| T-U18 ❌ | `decodeCursor('%%%no-base64%%%')` | `InvalidCursorException` (`INVALID_CURSOR`) |
| T-U19 | `@IsCentsString()` contra `"70000"`, `"-830000"`, `"0"` | Válidos, transformados a `70000n`, `-830000n`, `0n` |
| T-U20 ❌ | `"700.00"`, `"1,000"`, `"$700"`, `"7e3"`, `700` (número), `""` | Los seis rechazados con `VALIDATION_FAILED` |
| T-U21 | `parsePgError` sobre un error `P2010` con SQLSTATE `23505` y constraint `accounts_user_name_active_uniq` | `{ sqlstate:'23505', constraint:'accounts_user_name_active_uniq' }` |
| T-U22 | `parsePgError` para **cada uno** de los cuatro nombres de constraint de §9.2 | Los cuatro se extraen correctamente — un caso por nombre, no un caso genérico |
| T-U23 | `PrismaErrorMapper` para `P1001`…`P1011`, `23P01`, `23503`, `23514`, `25P02` | Cada uno produce la excepción, status y `code` de §9.2 |
| T-U24 | `nextDueOn(31, '2026-01-31')` (función de U08b, reusada por `recurring`) | `2026-03-01` — **no se reimplementa**, se importa |
| T-U25 | `buildBudgetCompensations` con entries `[{Nu,−50000n},{Comida,+50000n}]`, `categoryIds={Comida}`, `targetPeriodId=P2` | **1** draft: `{P2, Comida, −50000n}`, con `note` que contiene el `transactionId` y el `bookedAt` |
| T-U26 | Mismos entries con signos invertidos (reversa) | **1** draft: `{P2, Comida, +50000n}`. Sin caso especial |
| T-U27 | Entries `[{TDC,−70000n},{Comida,+30000n},{Comida,+40000n}]` | **1** solo draft: `{Comida, −70000n}`. Agregado por categoría |
| T-U28 | Entries con dos categorías distintas | **2** drafts, uno por categoría |
| T-U29 | Entries sin ninguna categoría (transferencia) | `[]`. **No es un error** |
| T-U30 | Entries de una categoría cuyos movimientos se cancelan (`+500n` y `−500n`) | `[]`. Un draft en cero violaría `budget_entries_amount_nonzero` |

**Nota sobre T-U24 — error de notación encontrado y corregido en la sesión 3 de tests del loop 2.** La redacción original daba `2026-03-31` para la llamada directa `nextDueOn(31, '2026-01-31')`, pero esa llamada — una sola invocación, sin encadenar — da `2026-03-01`: `31 >= 31` empuja el mes objetivo a febrero, que no tiene día 31, así que cae al primer día de marzo. `2026-03-31` solo sale de un **segundo** paso encadenado, usando `2026-03-01` (el resultado del primero) como nueva referencia — exactamente el escenario de dos pasos que ya describen **CA-22** y **T-N09** (plantilla confirmada en enero, vuelta a confirmar el 1 de marzo). No es un cambio de comportamiento: la función y sus 66 tests unitarios ya estaban bien: era la fila la que mezclaba los dos pasos en una sola notación.

## Grupo A-core — idempotencia y compensación a nivel de repository · *loop 1*

Se invoca `ITransactionRepository.createWithEntries()` **directamente**, sin HTTP. Los endpoints todavía no existen en el loop 1.

| ID | Escenario | Esperado |
|---|---|---|
| T-A01 | `createWithEntries` con `idempotencyKey = K1` | `created: true`; 1 fila en `transactions`; los entries escritos |
| T-A02 | Repetir con el mismo draft y `K1` | `created: false`; **mismo** `id`; `count(transactions)` sin cambio |
| T-A03 | Repetir con un draft **distinto** y `K1` | `created: false`, devolviendo la transacción **original**. La llave manda sobre el contenido |
| T-A06 | Misma llave, **usuario distinto** (`U2`) | `created: true`. El índice es `(user_id, idempotency_key)` |
| T-A07 | Dos llamadas con la misma llave lanzadas con `Promise.all` sobre **conexiones distintas**, dentro de **un solo `it()`** | Una devuelve `created: true`; la otra `created: false` **o** lanza `IdempotencyInFlightException`. **Nunca dos `created: true`.** `count(transactions)` = 1 |
| T-A08 | La excepción de T-A07, si ocurre | Es `IdempotencyInFlightException` con `code: IDEMPOTENCY_IN_FLIGHT` |
| T-A10 ❌ | Buscar `sleep`, `setTimeout`, `retry` o `backoff` en `prisma-transaction.repository.ts` | El archivo no contiene ninguno. P-04 se resolvió sin reintento |
| T-A11 | `createWithEntries` con dos compensaciones | Se escriben ambos `budget_entries` en la misma transacción de DB |
| T-A12 | Repetir esa llamada con la misma llave | `created: false`; **cero** `budget_entries` nuevos. El ajuste no se duplica |
| T-A13 ❌ | `createWithEntries` con una compensación apuntando a un periodo **cerrado** | Lanza `ClosedPeriodException` (`PERIOD_CLOSED`, `P1011`); **cero filas** en `transactions`, `entries` y `budget_entries`. Es la consecuencia asumida de §2.3 |

## Grupo A-http — idempotencia a nivel de header · *loop 2*

| ID | Escenario | Esperado |
|---|---|---|
| T-A20 | `POST /transactions/expenses` con llave `K1` | `201`; 1 fila en `transactions` |
| T-A21 | Repetir el mismo body con `K1` | `200`; **mismo** `id`; cuerpo idéntico al de T-A20, `budgetImpact` incluido |
| T-A04 ❌ | Sin header `Idempotency-Key` | `400 IDEMPOTENCY_KEY_REQUIRED`; cero filas |
| T-A05 ❌ | `Idempotency-Key: not-a-uuid` | `400 IDEMPOTENCY_KEY_INVALID`; cero filas |
| T-A09 | El header en `GET /accounts` | Ignorado en silencio; `200` normal |
| T-A22 | La respuesta `409 IDEMPOTENCY_IN_FLIGHT`, provocada con `Promise.all` | Trae header `Retry-After: 1` |

## Grupo B — gasto

| ID | Entrada | Esperado |
|---|---|---|
| T-B01 | `paidFrom=TDC`, `total="70000"`, `lines=[{Wifi,"70000"}]` | `201`; entries `TDC −70000`, `Wifi +70000` |
| T-B02 | `paidFrom=TDC`, `total="80000"`, `lines=[{Comida,"40000"}]`, `lentTo=[{Fer,"40000"}]` | `201`; 3 entries; `F1` da `Fer = +40000` |
| T-B03 ❌ | `total="80000"`, partes que suman `70000` | `422 SPLIT_TOTAL_MISMATCH`; cero filas |
| T-B04 ❌ | `paidFrom` = un sobre (`expense`) | `422 INVALID_ACCOUNT_ROLE`; cero filas; **`ErrorLog` no registra ningún `P1xxx`** |
| T-B05 ❌ | `lines[].categoryId` = una cuenta `asset` | `422 INVALID_ACCOUNT_ROLE`; cero filas |
| T-B06 ❌ | `lentTo[].receivableAccountId` = una cuenta `asset` | `422 INVALID_ACCOUNT_ROLE` |
| T-B07 ❌ | `paidFrom` = la cuenta `equity` `is_system` | `403 SYSTEM_ACCOUNT_NOT_ADDRESSABLE` |
| T-B08 ❌ | `paidFrom` archivada | `409 ACCOUNT_ARCHIVED` (S-R9) |
| T-B09 ❌ | `paidFrom` en `MXN`, sobre en `USD` | `422 MIXED_CURRENCY`; cero filas |
| T-B10 ❌ | `paidFrom` de `U2` estando autenticado como `U1` | `404 ACCOUNT_NOT_FOUND` — nunca `403`, nunca fuga de existencia |
| T-B11 ❌ | `total="-70000"` | `400 VALIDATION_FAILED` |
| T-B12 ❌ | `bookedAt="09/08/2026"` | `400 VALIDATION_FAILED` |
| T-B13 | `bookedAt` dentro de un periodo **cerrado** | `201`. **El ledger nunca rechaza.** El gasto aparece en `F2` de ese periodo como sobregiro |
| T-B14 | `bookedAt` en un hueco entre periodos | `201`; la transacción aparece en `GET /insights/unbudgeted-transactions` |

## Grupo C — ingreso y transferencia

| ID | Entrada | Esperado |
|---|---|---|
| T-C01 | Ingreso `Nu` ← `Sueldo`, `"1000000"` | `201`; `Nu +1000000`, `Sueldo −1000000` |
| T-C02 ❌ | `sourceId` = una cuenta `asset` | `422 INVALID_ACCOUNT_ROLE` |
| T-C03 ❌ | `toAccountId` = un sobre | `422 INVALID_ACCOUNT_ROLE` |
| T-C04 | Transferencia `Nu → TDC` de `"70000"` (pago de tarjeta) | `201`; `Nu −70000`, `TDC +70000`; **cero entries contra cuentas `expense`** |
| T-C05 ❌ | Transferencia con `toAccountId` = un sobre | `422 INVALID_ACCOUNT_ROLE` — es el error más común del dominio y tiene test propio |
| T-C06 ❌ | `from === to` | `422 SAME_ACCOUNT_TRANSFER` |
| T-C07 | Transferencia `Nu → Efectivo` | `201`; `F3` (`unassigned_funds`) **no cambia** — mover dinero entre `asset` no altera lo asignable |

## Grupo D — préstamos

| ID | Entrada | Esperado |
|---|---|---|
| T-D01 | Préstamo `Nu → Fer` de `"50000"` | `201`; `Nu −50000`, `Fer +50000`; **cero entries contra `expense`** |
| T-D02 | Tras T-D01, `GET /insights/unassigned-funds` | Bajó exactamente `50000` — `receivable` no cuenta en `dinero_real` |
| T-D03 | Cobro `Fer → Nu` de `"50000"` | `201`; saldo de `Fer` en `0`; `F3` vuelve al valor previo a T-D01 |
| T-D04 | Cobro parcial de `"20000"` sobre un préstamo de `"50000"` | `201`. Permitido |
| T-D05 | Cobro de `"80000"` sobre un préstamo de `"50000"` | `201`, `Fer` queda en `−30000`. **No se bloquea** |
| T-D06 | Incobrable `Fer → Pérdidas` de `"50000"` | `201`; `Fer −50000`, `Pérdidas +50000`; el gasto aparece en `F2` del periodo del `bookedAt` |
| T-D07 ❌ | Incobrable con `categoryId` = una cuenta `asset` | `422 INVALID_ACCOUNT_ROLE` |
| T-D08 ❌ | Buscar el literal `'Pérdidas'` o `'Perdidas'` en `src/` | No aparece en ningún archivo. **P-03 sigue abierto** |

## Grupo E — saldo inicial

| ID | Entrada | Esperado |
|---|---|---|
| T-E01 | `[{Nu,"1000000"},{TDC,"-250000"},{Efectivo,"80000"}]` | `201`; 4 entries; el de equity es `−830000`; `F1` refleja los tres saldos |
| T-E02 | `[{Nu,"1000"},{TDC,"-1000"}]` | `201`; **2** entries; ninguno contra `equity` |
| T-E03 | `[{Nu,"1000"},{Efectivo,"0"}]` | `201`; 2 entries; el saldo cero se descartó |
| T-E04 ❌ | `[{Nu,"0"}]` | `422 EMPTY_OPENING_BALANCE`; cero filas |
| T-E05 ❌ | `[{Comida,"1000"}]` (un sobre) | `422 INVALID_ACCOUNT_ROLE` |
| T-E06 ❌ | Un `accountId` = la cuenta `equity` | `403 SYSTEM_ACCOUNT_NOT_ADDRESSABLE` |
| T-E07 | Segunda invocación meses después, con una cuenta nueva | `201`. Se permite más de una vez |
| T-E08 | Inspeccionar la respuesta | La cuenta `equity` **no aparece** en `GET /accounts` en ningún momento |

## Grupo F — reversa

| ID | Entrada | Esperado |
|---|---|---|
| T-F01 | Reversa de un gasto `TDC −70000 / Wifi +70000` | `201`; entries `TDC +70000`, `Wifi −70000`; `reversesTransactionId` = original |
| T-F02 | Tras T-F01, `F1` | Los saldos de `TDC` y `Wifi` volvieron al valor previo |
| T-F03 | `bookedAt` omitido en el body | La reversa hereda el `bookedAt` del original |
| T-F04 | `bookedAt` explícito distinto | Se respeta el del body |
| T-F05 ❌ | Segunda reversa de la misma transacción | `409 ALREADY_REVERSED`; cero filas nuevas |
| T-F06 ❌ | Reversa de una reversa | `409 CANNOT_REVERSE_REVERSAL` (S-R7); cero filas nuevas |
| T-F07 ❌ | Reversa de una transacción de `U2` | `404 TRANSACTION_NOT_FOUND` |
| T-F08 | Reversa de una transacción cuya cuenta fue archivada después | `201`. S-R9 **no** aplica a reversas |
| T-F09 ❌ | `DELETE /transactions/{id}` | `404` de rutas — **el verbo no existe** |
| T-F10 | `PATCH /transactions/{id}` con `description` | `200`, descripción actualizada |
| T-F11 ❌ | `PATCH /transactions/{id}` con `bookedAt` | `400 VALIDATION_FAILED` (`forbidNonWhitelisted`) — nunca llega a R6 |

## Grupo G — cuentas

| ID | Entrada | Esperado |
|---|---|---|
| T-G01 | `POST /accounts` `{name:"Nu",kind:"cash"}` | `201`; `currency` default `"MXN"`; `balanceCents` `"0"` |
| T-G02 ❌ | Segundo `POST /accounts` con `{name:"nu"}` | `409 DUPLICATE_ACCOUNT_NAME` — el índice es sobre `lower(name)` |
| T-G03 ❌ | `POST /accounts` con `kind:"category"` o `kind:"asset"` | `400 VALIDATION_FAILED` — el enum del DTO solo admite `cash`, `credit`, `receivable` |
| T-G04 ❌ | `POST /accounts` con `rolloverType:"reset"` | `400 VALIDATION_FAILED` (campo no declarado) |
| T-G05 | `GET /accounts` con una cuenta archivada | La archivada **no** aparece (S-R4) |
| T-G06 | `GET /accounts?includeArchived=true` | Sí aparece, con `archivedAt` no nulo |
| T-G07 | `GET /accounts` con 3 cuentas | **Una sola** llamada a `accountBalances`; se verifica con un spy sobre `IQueryRepository`. Nunca N+1 |
| T-G08 ❌ | Archivar una cuenta `asset` con saldo `70000` | `409 ACCOUNT_NOT_EMPTY` (R8); `archivedAt` sigue nulo |
| T-G09 | Archivar una cuenta `asset` con saldo `0` | `200`; `archivedAt` no nulo |
| T-G10 ❌ | Archivar una cuenta `receivable` con saldo pendiente | `409 ACCOUNT_NOT_EMPTY` — R8 cubre `receivable` |
| T-G11 ❌ | Archivar lo ya archivado | `409 ALREADY_ARCHIVED` |
| T-G12 | Desarchivar | `200`; `archivedAt` nulo |
| T-G13 ❌ | Desarchivar cuando existe otra cuenta activa con el mismo nombre | `409 DUPLICATE_ACCOUNT_NAME` |
| T-G14 ❌ | `PATCH /accounts/{id}` con `currency:"USD"` teniendo entries | `409 CURRENCY_LOCKED` (S-R5) |
| T-G15 | `PATCH /accounts/{id}` con `currency:"USD"` **sin** entries | `200` |
| T-G16 | **Movido a Grupo O (T-O15) y reformulado** — ver nota abajo | — |
| T-G17 ❌ | `GET /accounts/{id}` de `U2` | `404 ACCOUNT_NOT_FOUND` |

**Nota sobre T-G16 — encontrado y corregido en la sesión de tests del loop 1.**
La redacción original ("cuenta archivada **con saldo**") es estructuralmente
inalcanzable por HTTP: R8 exige saldo **exactamente cero** para que
`POST /accounts/{id}/archive` tenga éxito, así que un archivado por la vía
normal nunca puede terminar con saldo distinto de cero — la única forma de
llegar a ese estado es con una reversa (`POST /transactions/{id}/reversal`,
A07) sobre un movimiento anterior al archivado. El test no estaba
incompleto, estaba mal planteado. Movido a Grupo O como **T-O15**
(reformulado con saldo cero, alcanzable) — la garantía de S-R4 con saldo
**distinto de cero** ya la cubre T-OC02 (`queries-repository.integration.spec.ts`,
loop 1), que archiva con SQL directo sin pasar por R8/el Service.

## Grupo H — sobres y fuentes de ingreso

| ID | Entrada | Esperado |
|---|---|---|
| T-H01 | `GET /categories` en un usuario recién sembrado | 7 sobres, cada uno con su `rolloverType` |
| T-H02 | `POST /categories` `{name:"Mascotas",rolloverType:"accumulate"}` | `201` |
| T-H03 ❌ | `POST /categories` sin `rolloverType` | `400 VALIDATION_FAILED` |
| T-H04 | `PATCH /categories/{id}` `{rolloverType:"reset"}` | `200`; ningún `budget_entry` se re-materializa |
| T-H05 | `GET /categories?periodId=P1` | Cada sobre trae `assignedCents`, `spentCents`, `availableCents`, `hasBudget` |
| T-H06 | Sobre con dos asignaciones `+50000` y `−50000` | `assignedCents:"0"` y **`hasBudget:true`** — se deriva del conteo, no del monto |
| T-H07 | Sobre sin asignaciones ni gasto | `assignedCents:"0"`, `hasBudget:false`, y **aparece** en la lista |
| T-H08 | Sobre archivado a media quincena, con gasto en el periodo | Con `periodId`, **sigue apareciendo** con su gasto real (S-R4) |
| T-H09 | Archivar un sobre con gasto acumulado y sin asignaciones vigentes | `200` — R8 exime `expense` |
| T-H10 ❌ | Archivar un sobre con una asignación vigente en un periodo **abierto** | `409 CATEGORY_HAS_ALLOCATIONS` (S-R6) |
| T-H11 | Archivar un sobre cuyas únicas asignaciones están en un periodo **cerrado** | `200` — S-R6 solo mira periodos abiertos |
| T-H12 | `GET /income-sources` | Solo `Sueldo`; **ningún sobre** |
| T-H13 ❌ | `POST /income-sources` con `rolloverType` | `400 VALIDATION_FAILED` |
| T-H14 ❌ | `POST /income-sources` con `name:"Comida"` (ya existe como sobre) | `409 DUPLICATE_ACCOUNT_NAME` — el nombre es único entre **todas** las cuentas activas |
| T-H15 | `GET /categories/{id}/ledger` de `Comida` con 3 gastos | 3 entries, orden `bookedAt DESC`, cada uno con su transacción |
| T-H16 ❌ | `GET /categories/{id}/ledger` con el `id` de una cuenta `asset` | `404 CATEGORY_NOT_FOUND` |

## Grupo I — consulta de ledger y paginación

| ID | Entrada | Esperado |
|---|---|---|
| T-I01 | 120 transacciones, `GET /transactions?limit=50` | 50 filas, `nextCursor` no nulo |
| T-I02 | Paginar con el `nextCursor` hasta agotar | 120 filas en total, **cero duplicados**, `nextCursor` final `null` |
| T-I03 | Dos transacciones con el **mismo** `bookedAt` en el límite de página | Ninguna se pierde ni se repite — el desempate por `id` funciona |
| T-I04 ❌ | `?cursor=zzz` | `400 INVALID_CURSOR` |
| T-I05 ❌ | `?limit=500` | `400 VALIDATION_FAILED` (máximo 100) |
| T-I06 | `GET /transactions?from=2026-08-01&to=2026-08-15` | Solo las de ese rango, inclusivo en ambos extremos |
| T-I07 | `GET /transactions?accountId=TDC` | Solo transacciones con al menos un entry contra `TDC` |
| T-I08 | `GET /transactions/{id}` | La transacción con **todos** sus `movements`, cada uno con `accountKind`. **Ninguno con `accountKind:"system"`** salvo el saldo inicial, donde la cuenta ancla se omite del arreglo |
| T-I09 | `GET /accounts` con 60 cuentas y `?pageSize=25&page=2` | 25 filas, `total:60`, `page:2` |
| T-I10 ❌ | `GET /transactions` como `U2` con datos de `U1` | Lista vacía. **Nunca** filas de otro usuario |

## Grupo K — periodos

| ID | Entrada | Esperado |
|---|---|---|
| T-K01 | `POST /periods` `{startsOn:"2026-08-01",endsOn:"2026-08-15"}` | `201`; `closedAt:null` |
| T-K02 ❌ | Segundo periodo `2026-08-10` → `2026-08-20` | `409 PERIOD_OVERLAP` (`23P01`) |
| T-K03 | Periodos `1–15 ago` y `20–31 ago` | `201` en ambos. **Los huecos están permitidos** |
| T-K04 ❌ | `endsOn` anterior a `startsOn` | `422 INVALID_INPUT` (`23514`) o `400` si el DTO lo atrapa antes; el test acepta el que corresponda a la implementación pero **verifica que cero filas se escribieron** |
| T-K05 | `GET /periods/current` con hoy dentro del rango | El periodo; `200` |
| T-K06 ❌ | `GET /periods/current` con hoy en un hueco | `404 NO_CURRENT_PERIOD` |
| T-K07 | `profile.timezone = 'Pacific/Kiritimati'`, un instante en que UTC y la zona local caen en **días distintos** | `GET /periods/current` resuelve por la fecha **local**, no por `now()::date` de Postgres |
| T-K08 | `PATCH /periods/{id}` con fechas nuevas, periodo abierto | `200` |
| T-K09 ❌ | `PATCH /periods/{id}` con fechas, periodo **cerrado** | `409 PERIOD_CLOSED`; las fechas no cambiaron (R10 como red) |
| T-K10 | `DELETE /periods/{id}` sin asignaciones y abierto | `204`; `deletedAt` no nulo; **la fila sigue existiendo** |
| T-K11 ❌ | `DELETE /periods/{id}` con una asignación vigente | `409 PERIOD_NOT_EMPTY` |
| T-K12 ❌ | `DELETE /periods/{id}` cerrado | `409 PERIOD_CLOSED` |
| T-K13 | Borrar un periodo que contenía transacciones | `204`; esas transacciones aparecen en `GET /insights/unbudgeted-transactions` |
| T-K14 | Crear un periodo nuevo con el mismo rango que uno borrado | `201`. El `EXCLUDE` tiene predicado `deleted_at IS NULL` |

## Grupo L — asignaciones

| ID | Entrada | Esperado |
|---|---|---|
| T-L01 | `POST /allocations` `{Comida,"200000"}` | `201`; `source:"manual"` |
| T-L02 | Segundo `POST` `{Comida,"-50000"}` | `201`; `assignedCents` de `F2` = `"150000"` |
| T-L03 ❌ | `POST /allocations` `{Comida,"0"}` | `400 VALIDATION_FAILED` |
| T-L04 ❌ | `POST /allocations` con `categoryId` de una cuenta `asset` | `422 INVALID_BUDGET_CATEGORY` |
| T-L05 | `PUT /allocations/Comida` `{targetAssignedCents:"500000"}` estando en `300000` | `200`; se creó **un** entry de `+200000`; total `500000` |
| T-L06 | Mismo `PUT` repetido | `200`; **cero** entries nuevos; total sigue en `500000` |
| T-L07 | **Dos `PUT` concurrentes** con `target="500000"` desde `300000`, lanzados con `Promise.all` sobre **conexiones distintas**, dentro de **un solo `it()`** | El total final es **exactamente `500000`**. Si sale `700000`, el delta se calculó fuera del `FOR UPDATE` y la implementación está mal |
| T-L08 | `POST /allocations/move` `{Comida→Salud,"30000"}` | `200`; dos entries: `Comida −30000`, `Salud +30000`; el total asignado del periodo no cambió |
| T-L09 ❌ | `move` con `from === to` | `422 SAME_CATEGORY_MOVE` |
| T-L10 ❌ | Cualquier escritura de asignación sobre un periodo cerrado | `409 PERIOD_CLOSED`; cero filas (R11 como red) |
| T-L11 | `DELETE /allocations/{id}` en periodo abierto | `204`; `deletedAt` no nulo; `F2` deja de contarla |
| T-L12 ❌ | `DELETE /allocations/{id}` en periodo cerrado | `409 PERIOD_CLOSED` |
| T-L13 ❌ | `DELETE` de una asignación de `U2` | `404 ALLOCATION_NOT_FOUND` |

## Grupo M — cierre de periodo

Escenario base de este grupo, salvo indicación distinta: periodos `P1 = 1–15 ago` y `P2 = 16–31 ago`, ambos abiertos. `Comida` es `reset`, `Servicios` es `accumulate`.

| ID | Entrada | Esperado |
|---|---|---|
| T-M01 | `Servicios` asignado `200000`, gastado `50000` → `available +150000`. `POST /periods/P1/close` | `200`; existe en `P2` un `budget_entry` `source:'rollover'` de `+150000`; `P1.closedAt` no nulo |
| T-M02 | `Comida` (`reset`) `available +150000` | **No** existe rollover de `Comida` en `P2` |
| T-M03 | `Comida` (`reset`) `available −30000` | Existe en `P2` un rollover de **`−30000`**. El déficit se arrastra aunque sea `reset` |
| T-M04 | `Servicios` (`accumulate`) `available −30000` | Existe rollover de `−30000` en `P2` |
| T-M05 | Categoría con `available = 0` | **Cero** entries de rollover para ella |
| T-M06 | Categoría sin presupuesto ni gasto | **Cero** entries de rollover |
| T-M07 ❌ | `POST /periods/P1/close` dos veces | La segunda: `409 PERIOD_ALREADY_CLOSED`; **cero** rollovers duplicados en `P2` |
| T-M08 ❌ | `P2` no existe | `409 NEXT_PERIOD_REQUIRED`; `P1.closedAt` sigue nulo; cero entries escritos |
| T-M09 ❌ | `P2` cerrado | `409 NEXT_PERIOD_CLOSED`; `P1` sin cerrar |
| T-M10 ❌ | Cerrar `P2` existiendo `P1` abierto | `409 EARLIER_PERIOD_OPEN` (S-R8) |
| T-M11 | Hueco entre `P1 = 1–15` y `P3 = 20–31` | El rollover se materializa en `P3`. "El siguiente" es el `starts_on` mínimo estrictamente mayor a `ends_on` |
| T-M12 | `GET /periods/P1/close-preview` con el escenario de T-M01 y T-M03 | `Servicios: carry_forward 150000`, `Comida: carry_deficit -30000`, `canClose:true`, `blockers:[]`. **Cero escrituras** — se verifica con `count(budget_entries)` antes y después |
| T-M13 | `close-preview` sin `P2` | `canClose:false`, `blockers:["NEXT_PERIOD_REQUIRED"]` |
| T-M14 | Tras cerrar `P1`, `GET /insights/unassigned-funds` | El dinero comprometido de `P1` quedó liberado del cálculo, y el rollover materializado en `P2` sí cuenta. **Sin doble conteo** (Fallo A) |
| T-M15 | Cierre que falla por `NEXT_PERIOD_REQUIRED` en un escenario con sobrantes y déficits que **sí** habrían generado rollovers | `409 NEXT_PERIOD_REQUIRED`; **cero** `budget_entries` escritos en cualquier periodo y `P1.closedAt` sigue nulo. Ejercita el rollback real por una vía natural y provocable, sin mockear Prisma |

## Grupo N — recurrentes

| ID | Entrada | Esperado |
|---|---|---|
| T-N01 | `POST /recurring-templates` `{name:"Wifi",categoryId:Wifi,amountCents:"70000",dayOfMonth:15}` | `201`; `nextDueOn` calculado con la función de U08b |
| T-N02 ❌ | `dayOfMonth:0` o `32` | `400 VALIDATION_FAILED` |
| T-N03 ❌ | `amountCents:"-100"` | `400 VALIDATION_FAILED` |
| T-N04 ❌ | `categoryId` de una cuenta `asset` | `422 INVALID_ACCOUNT_ROLE` |
| T-N05 | `confirm` sin body, template con `accountId=TDC` | `201`; transacción `TDC −70000`, `Wifi +70000`; `bookedAt` = hoy en `profile.timezone` |
| T-N06 | `confirm` con `amountCents:"72500"` | La transacción usa `72500`; el template conserva su estimado `70000` |
| T-N07 | `confirm` con `paidFromAccountId=Nu` | La transacción usa `Nu`; el template conserva `TDC` |
| T-N08 ❌ | `confirm` de un template sin `accountId` y sin `paidFromAccountId` en el body | `422 PAYMENT_ACCOUNT_REQUIRED`; cero filas |
| T-N09 | Template `dayOfMonth:31`, `lastConfirmedOn:2026-01-31`, `confirm` con `bookedAt:2026-03-01` | `nextDueOn = 2026-03-31`. **No** salta a abril |
| T-N10 | `confirm` repetido con la misma `Idempotency-Key` | `200`; **una** transacción; `nextDueOn` y `lastConfirmedOn` **no avanzaron dos veces** |
| T-N11 | `GET /recurring-templates?dueOnly=true` | Solo los de `nextDueOn <= hoy` en `profile.timezone`, `isActive=true`, `deletedAt` nulo |
| T-N12 | `DELETE /recurring-templates/{id}` | `204`; `deletedAt` no nulo; desaparece del listado |
| T-N13 ❌ | `POST /recurring-templates/{id}/skip` | `404` de rutas — el endpoint no existe |
| T-N14 | Inspeccionar `recurring.service.ts` | Importa `buildExpenseEntries` y `nextDueOn`; **no** los reimplementa; **no** importa `TransactionsModule` |

## Grupo O-core — F1–F4 a nivel de repository · *loop 1*

Sin IDs propios en la versión original de este documento — `§11.0` los destinaba a
`test/integration/api/core/queries-repository.integration.spec.ts` sin especificar
casos. Agregado al cerrar el alcance del loop 1 con Luis (sesión de tests de
`A00–A06`). **F1–F4 ya están cubiertas por los 123 tests de `TASK-db.md`** — esto
NO vuelve a probar la aritmética de las funciones SQL, prueba que
`PrismaQueryRepository` las envuelve correctamente: `$queryRaw` parametrizado
(nunca interpolación de string), `unassignedFunds` desempaca la fila única a
`bigint` (no arreglo, no `Decimal`), los tipos de `types.ts` coinciden con lo que
Postgres devuelve, y **ningún método filtra `archived_at` por su cuenta** — es
donde S-R4 se rompe en silencio si alguien agrega un `WHERE archived_at IS NULL`
"por si acaso".

Los valores esperados se reusan tal cual de `ARCHITECTURE.md` §3.9 (ejemplos
canónicos de `fn_unassigned_funds`, ya validados contra la implementación real
en `TASK-db.md`) — ningún valor se recalcula aquí.

| ID | Escenario | Esperado |
|---|---|---|
| T-OC01 | `accountBalances(A.userId)` con cuentas de `A` y de `B` sembradas | Solo filas de `A`; cada fila `{accountId, name, type, currency, balanceCents}`; `balanceCents` es `typeof 'bigint'` |
| T-OC02 | Una cuenta de `A` con saldo `0` se archiva (`archivedAt` no nulo); se llama `accountBalances(A.userId)` antes y después | La cuenta aparece **en ambas** llamadas — S-R4: `accountBalances` nunca filtra `archived_at` |
| T-OC03 | `categoryBalances(A.userId, periodId)` | Cada fila `{categoryId, name, assignedCents, spentCents, availableCents, hasBudget}`; los tres montos son `typeof 'bigint'` |
| T-OC04 | Categoría con dos asignaciones `+50000` y `−50000` en el periodo | `assignedCents: 0n` **y** `hasBudget: true` — se deriva del conteo de filas, no del monto (mismo caso que documenta `ARCHITECTURE.md` §3.9 para F2) |
| T-OC05 | Escenario canónico #1 de §3.9: cash `1000000n`, `Comida` asignado `200000n` gastado `50000n`, `Salud` gastado `30000n` sin presupuesto, un periodo abierto | `unassignedFunds(userId)` devuelve **`740000n`** directo (no `[{unassignedCents: ...}]`); `typeof resultado === 'bigint'` |
| T-OC06 | Escenario canónico #2 de §3.9: mismo estado + `+500000n` de ingreso + un segundo periodo abierto con `Comida` asignado `+100000n` | `unassignedFunds(userId)` devuelve **`1140000n`** — confirma que la función NO usa la resta agregada global (que daría `800000n`+ en el primer escenario, atrapado ya por F3 misma, pero el wrapper no debe transformar el resultado) |
| T-OC07 | `transactionsWithoutPeriod(A.userId)` con 2 transacciones en huecos entre periodos, en orden de inserción no cronológico | Cada fila `{transactionId, bookedAt, description}`; orden `bookedAt DESC` |

## Grupo O — insights

| ID | Entrada | Esperado |
|---|---|---|
| T-O01 | `GET /insights/account-balances` tras el saldo inicial de T-E01 | `Nu:"1000000"`, `TDC:"-250000"`, `Efectivo:"80000"`; la cuenta `equity` **no aparece** |
| T-O02 | Una cuenta archivada con saldo | **Sí aparece** en `account-balances` (S-R4) |
| T-O03 | Cuenta recién creada sin movimientos | Aparece con `"0"`, no desaparece (`LEFT JOIN` de F1) |
| T-O04 | Escenario canónico de §3.9: cash `1000000`, `Comida` asignado `200000` gastado `50000`, `Salud` gastado `30000` sin presupuesto | `GET /insights/unassigned-funds` → `{"unassignedCents":"740000"}` |
| T-O05 | Dos periodos abiertos: el anterior con `1800` comprometido, el nuevo con `1000`, cash `1420000` | `{"unassignedCents":"1140000"}`. **Ambos periodos abiertos cuentan** |
| T-O06 | Usuario recién creado, sin nada | `{"unassignedCents":"0"}` — una fila, no cero filas |
| T-O07 | `GET /insights/category-balances?periodId=P1` | Todos los sobres, incluidos los que no tienen ni asignación ni gasto |
| T-O08 ❌ | `category-balances` sin `periodId` | `400 VALIDATION_FAILED` |
| T-O09 ❌ | `category-balances` con un `periodId` de `U2` | `404 PERIOD_NOT_FOUND` |
| T-O10 | Transacciones en un hueco entre periodos | Aparecen en `unbudgeted-transactions` con `description` |
| T-O11 | Transacción dentro de un periodo **cerrado** | **No** aparece en `unbudgeted-transactions` — F4 ignora `closed_at` |
| T-O12 | `GET /insights/dashboard?periodId=P1` | Trae los cuatro bloques; los valores coinciden **exactamente** con los de los cuatro endpoints individuales |
| T-O13 | `GET /insights/dashboard` sin `periodId`, con un periodo que cubre hoy | Resuelve el periodo actual por `profile.timezone` |
| T-O14 | Inspeccionar `insights.service.ts` | **Cero** aritmética de montos: ni `+`, ni `-`, ni `reduce` sobre `bigint` |
| T-O15 | Cuenta con saldo **cero** se archiva (`POST /accounts/{id}/archive`, éxito garantizado por R8); se llama `GET /insights/account-balances` antes y después | La cuenta aparece en **ambas** llamadas — reformulación de T-G16 (Grupo G), movida aquí por ser estructuralmente inalcanzable con saldo distinto de cero por HTTP (ver nota en Grupo G). El caso con saldo no-cero real ya lo cubre T-OC02 a nivel de repository, loop 1 |

## Grupo P — perfil

| ID | Entrada | Esperado |
|---|---|---|
| T-P01 | `GET /me` con un usuario nuevo | `200`; `timezone:"America/Mexico_City"`; `userId` = `sub` del JWT |
| T-P02 | `PATCH /me` `{timezone:"America/Monterrey"}` | `200`; persiste |
| T-P03 ❌ | `PATCH /me` `{timezone:"Marte/Olympus"}` | `400 INVALID_TIMEZONE` |
| T-P04 ❌ | `PATCH /me` `{userId:"..."}` | `400 VALIDATION_FAILED` |
| T-P05 | Primer request autenticado de un usuario sin fila en `profiles` | El `ProfileInterceptor` la crea; el endpoint responde normal |
| T-P06 ❌ | Usuario con `deleted_at` no nulo | `403 PROFILE_DELETED`; la excepción no se traga |

## Grupo Q — errores y mapeo

| ID | Entrada | Esperado |
|---|---|---|
| T-Q01 | Cualquier error | La respuesta trae **exactamente** `statusCode`, `code`, `message`, `timestamp`, `path` (más `details` en validación). Ningún campo extra, ninguno faltante |
| T-Q02 | Un error interno provocado | `500` · `INTERNAL_ERROR`; **sin** stack trace, **sin** mensaje de Prisma, **sin** SQL en el cuerpo |
| T-Q03 | El mismo error | Quedó una fila en `ErrorLog`; la respuesta al cliente no se retrasó ni cambió |
| T-Q04 | Un error cuyo contexto arrastra un `BigInt` | `ErrorLog` lo persistió con el serializador defensivo; **no** lanzó `TypeError` dentro del filtro |
| T-Q05 | `GET /accounts` sin `Authorization` | `401` · `UNAUTHORIZED` |
| T-Q06 | Token expirado | `401` · `UNAUTHORIZED` |
| T-Q07 | Provocar cada uno de los 11 `ERRCODE` `P1001`–`P1011` por vía directa de repository | Cada uno mapea al `code` y status de §9.2. **Un caso por regla** |
| T-Q08 | `25P02` | Nunca aparece en ninguna corrida de la suite. Si aparece, se usó `INSERT` plano en lugar de `ON CONFLICT DO NOTHING` |

## Grupo R — contrato

| ID | Entrada | Esperado |
|---|---|---|
| T-R01 | Recorrer **todas** las respuestas de la suite | Todo campo cuyo nombre termine en `Cents` es un **string**. Cero `number` de monto en cualquier punto |
| T-R02 | `GET /accounts` sin el prefijo (`/accounts`) | `404`. Todas las rutas viven bajo `/api/v1` |
| T-R03 | Un `POST` con un campo extra no declarado | `400 VALIDATION_FAILED` con `details` que nombra el campo |
| T-R04 | Un monto de `9007199254740993` centavos (más de 2^53) | Round-trip exacto: entra como string, se persiste, sale idéntico. **Cero pérdida de precisión** |
| T-R05 | Análisis estático de los `imports` de cada `*.module.ts` de dominio | **Ningún módulo de dominio importa a otro módulo de dominio.** Solo `AccountsDataModule`, `PeriodsDataModule`, `QueriesModule`, `LedgerModule`, `AuthModule` y `common` (D4) |
| T-R06 | `grep` de `PrismaClient` en `src/**/*.service.ts` y `src/**/*.controller.ts` | Cero coincidencias |
| T-R07 | `grep` de `entries`, `debit`, `credit`, `asset`, `liability`, `equity` en `src/**/dto/` | Cero coincidencias. El vocabulario de partida doble no cruza el contrato (§5.6) |
| T-R08 | Buscar `reopen` en `src/` | Cero coincidencias. P-02 está fuera de alcance |
| T-R09 | Cada respuesta real contra su fixture JSON versionado de `test/fixtures/contract/` (§11.1) | Deep-equal tras normalizar. Un desajuste significa que alguien editó el código o el fixture sin el otro |
| T-R10 | `git status` de `prisma/migrations/` | Sin cambios. **Cero migraciones nuevas** |
| T-R11 | Respuesta de **creación** de cualquier `POST /transactions/*` | **No** contiene `movements` ni ningún arreglo de montos por cuenta. **Sí** contiene `budgetImpact` |
| T-R12 | Buscar `budget_entries` escritos fuera de `BudgetModule` y de `PrismaTransactionRepository` | Cero. Las compensaciones se escriben en un solo lugar |

## Grupo S — captura tardía · *loop 2*

Escenario base del grupo: `P1 = 1–15 ago` **cerrado**, `P2 = 16–31 ago` **abierto**, hoy es `2026-08-20`, `profile.timezone = 'America/Mexico_City'`.

| ID | Entrada | Esperado |
|---|---|---|
| T-S01 | Gasto de `"50000"` en `Comida`, `bookedAt="2026-08-12"` | `201`; existe en `P2` un `budget_entry` `source:'manual'` de `−50000` contra `Comida`, con `note` que referencia la transacción; `budgetImpact.status="compensated"`, `closedPeriodId=P1`, `compensatedInPeriodId=P2` |
| T-S02 | Tras T-S01, `GET /periods/P2/allocations` | El compensatorio aparece en la lista |
| T-S03 | Tras T-S01, `GET /categories?periodId=P2` | `Comida` tiene `assignedCents` reducido en `50000`; `spentCents` **sin cambio** (el gasto es de `P1`) |
| T-S04 | Tras T-S01, `GET /insights/category-balances?periodId=P1` | El gasto **sí** aparece en `spentCents` de `P1`. El periodo cerrado conserva su historia |
| T-S05 ❌ | Mismo gasto, pero **sin** ningún periodo abierto que cubra hoy | `201`; **cero** `budget_entries` nuevos; `budgetImpact.status="uncompensated"`. **La transacción se crea igual** |
| T-S06 | Gasto tardío repartido entre `Comida` (`"30000"`) y `Salud` (`"20000"`) | **Dos** compensatorios en `P2`, uno por categoría, por `−30000` y `−20000` |
| T-S07 | Gasto tardío con `Comida` dos veces en `lines` (`"30000"` y `"40000"`) | **Un solo** compensatorio de `−70000`. Agregado por categoría |
| T-S08 | Repetir T-S01 con la misma `Idempotency-Key` | `200`; **cero** `budget_entries` nuevos; el `budgetImpact` del cuerpo es idéntico al de la primera respuesta |
| T-S09 | Reversa de T-S01 **sin** `bookedAt` en el body | `201`; segundo `budget_entry` de `+50000` en `P2`; la suma de los dos compensatorios es `0` |
| T-S10 ❌ | Reversa de T-S01 con `bookedAt` sobreescrito a hoy (`2026-08-20`, dentro de `P2` abierto) | `422 REVERSAL_DATE_LOCKED`; **cero filas escritas** — ni transacción, ni entries, ni `budget_entries`. El original generó compensatorio, así que su fecha de reversa está bloqueada |
| T-S10b | Reversa con `bookedAt` sobreescrito de una transacción **cuyo `bookedAt` cae en un periodo abierto** | `201`. El bloqueo aplica **solo** cuando el original generó compensatorio; en el caso normal el campo sigue siendo sobreescribible |
| T-S11 | `loan-write-off` con `bookedAt="2026-08-12"` | Compensatorio negativo en `P2` contra la categoría indicada |
| T-S12 | `recurring-templates/{id}/confirm` con `bookedAt="2026-08-12"` | Compensatorio negativo en `P2`; `budgetImpact` viaja dentro de `transaction` |
| T-S13 | Transferencia, ingreso, préstamo y cobro con `bookedAt="2026-08-12"` | Los cuatro: `201`, **cero** compensatorios. No tocan categorías |
| T-S14 | **Retirado de la suite — ver nota en §2.3** | — |
| T-S15 | Gasto con `bookedAt` en un hueco entre periodos | `budgetImpact.status="no_period"`; cero compensatorios; aparece en `unbudgeted-transactions` |
| T-S16 | Gasto con `bookedAt` dentro de `P2` (abierto) | `budgetImpact.status="in_open_period"`; cero compensatorios |
| T-S17 | Compensatorio contra una categoría **sin** presupuesto en `P2` | `assignedCents` de esa categoría queda negativo, `hasBudget:true` y `status:"overspent"` en `P2` — aunque `spentCents` sea `"0"`. Es correcto y el frontend lo explica con la `note` |
## 11.1 Fixtures de contrato

`API-CONTRACT.md` es documentación legible; **los fixtures JSON son la verdad ejecutable.** Los ejemplos de response del contrato se extraen a archivos versionados en el repo, y T-R09 compara las respuestas reales contra ellos. Verificación manual no sirve: nadie la hace la vigésima vez.

**Ubicación:** `test/fixtures/contract/`. Al menos uno por módulo:

| Archivo | Endpoint |
|---|---|
| `profile.me.json` | `GET /me` |
| `accounts.list.json` | `GET /accounts` |
| `accounts.create.json` | `POST /accounts` |
| `accounts.ledger.json` | `GET /accounts/{id}/ledger` |
| `categories.list-with-period.json` | `GET /categories?periodId=` |
| `income-sources.list.json` | `GET /income-sources` |
| `transactions.expense-create.json` | `POST /transactions/expenses` |
| `transactions.expense-create-late.json` | `POST /transactions/expenses` con `budgetImpact.status="compensated"` |
| `transactions.detail.json` | `GET /transactions/{id}` |
| `transactions.list.json` | `GET /transactions` |
| `periods.list.json` | `GET /periods` |
| `periods.close-preview.json` | `GET /periods/{id}/close-preview` |
| `periods.close.json` | `POST /periods/{id}/close` |
| `allocations.list.json` | `GET /periods/{id}/allocations` |
| `allocations.set.json` | `PUT /periods/{id}/allocations/{categoryId}` |
| `recurring.list.json` | `GET /recurring-templates` |
| `recurring.confirm.json` | `POST /recurring-templates/{id}/confirm` |
| `insights.account-balances.json` | `GET /insights/account-balances` |
| `insights.category-balances.json` | `GET /insights/category-balances` |
| `insights.unassigned-funds.json` | `GET /insights/unassigned-funds` |
| `insights.unbudgeted-transactions.json` | `GET /insights/unbudgeted-transactions` |
| `insights.dashboard.json` | `GET /insights/dashboard` |
| `errors.validation-failed.json` | `400 VALIDATION_FAILED` |
| `errors.period-closed.json` | `409 PERIOD_CLOSED` |
| `errors.not-found.json` | `404 ACCOUNT_NOT_FOUND` |

**Cómo se compara.** Los ids y los instantes son volátiles; los montos no. El test normaliza la respuesta real antes del deep-equal:

- Todo valor que sea un UUID → `"<uuid>"`.
- Todo valor RFC 3339 → `"<timestamp>"`.
- Todo lo demás se compara **literal**, incluidos **todos los montos**. El seed del fixture base es determinista, así que `"150000"` tiene que salir `"150000"`.

Los fixtures se escriben con esos mismos placeholders. Un campo nuevo, renombrado o desaparecido rompe el deep-equal, que es exactamente lo que se quiere.

**Regla de mantenimiento:** si cambias una respuesta, cambias el fixture **y** el bloque correspondiente de `API-CONTRACT.md` en la misma vuelta. Los tres tienen que contar la misma historia.

---

# 12. Acciones humanas requeridas

En este orden exacto. Las primeras cuatro son **bloqueantes**: sin ellas el loop no puede ni arrancar ni verificar.

### 1. Confirmar que la capa de datos y la de auth están en verde

```
npx prisma migrate status
npm run test:unit
npm run test:integration
```

Los tres en `0`. **Verificación:** `migrate status` imprime `Database schema is up to date!`. Si algo está en rojo, se arregla **antes** de empezar esta tarea; no se arranca sobre una base inestable.

### 2. Agregar los tres scripts de API y ampliar el ignore de `test:integration:db`

`test:integration:db` hoy excluye solo `test/integration/auth/`. Sin este cambio, los tests de esta tarea se cuelan en la condición de paro de `TASK-db.md` y la rompen.

```json
"test:integration:api:core":   "dotenv -e .env.test -- jest --config test/jest-integration.config.js --runInBand --testPathPattern=\"test/integration/api/core/\"",
"test:integration:api:domain": "dotenv -e .env.test -- jest --config test/jest-integration.config.js --runInBand --testPathPattern=\"test/integration/api/domain/\"",
"test:integration:api":        "dotenv -e .env.test -- jest --config test/jest-integration.config.js --runInBand --testPathPattern=\"test/integration/api/\"",
"test:integration:db":         "dotenv -e .env.test -- jest --config test/jest-integration.config.js --runInBand --testPathIgnorePatterns=\"test/integration/(auth|api)/\""
```

**El filtro es por carpeta, no por nombre de archivo.** `test/integration/api/core/` y `test/integration/api/domain/` son las dos únicas subcarpetas; un archivo suelto directamente en `test/integration/api/` **no lo recoge ningún script de loop** y quedaría fuera de ambas condiciones de paro. Es el error silencioso más probable de este setup.

**Verificación, los cuatro:**

1. `npm run test:integration:db` sigue en verde y su conteo de tests **no cambió** respecto a antes de esta tarea.
2. `npm run test:integration:api:core` recoge exactamente los archivos de `core/`.
3. `npm run test:integration:api:domain` recoge exactamente los de `domain/`.
4. La suma de los conteos de `:core` y `:domain` es **igual** al conteo de `test:integration:api`. Si no cuadra, hay un archivo huérfano.

### 3. Confirmar dónde se invoca `EnsureProfileExistsService`

Revisar si `TASK-auth` ya lo cableó en un guard, middleware o interceptor.

- **Si ya está cableado:** el agente lo reutiliza y **no** crea `ProfileInterceptor`. Confirmar dónde queda expuesto el `ProfileRow` en el request.
- **Si no está cableado:** el agente crea `ProfileInterceptor` según §5.6.

**Verificación:** `grep -rn "EnsureProfileExistsService" src/`. Este es el único punto de esta tarea donde puede haber duplicación silenciosa con la capa de auth.

### 4. Confirmar el default y la existencia de `profiles.timezone`

```sql
SELECT column_name, column_default, is_nullable
FROM information_schema.columns
WHERE table_name = 'profiles' AND column_name = 'timezone';
```

**Verificación:** existe, no es nulable, y su default es `'America/Mexico_City'`. Si el default fuera otro, `API-CONTRACT.md` está mal y hay que corregirlo antes de que el chat del frontend lo consuma.

### 5. Generar un JWT de prueba para la suite

Firmado con la llave EC de prueba que genera `test/setup/auth/jwt.ts` (`signValidToken`), con `sub` = el `id` del usuario del fixture. **Verificación:** `GET /api/v1/me` con ese token responde `200`.

*(Una versión previa decía "firmado con el mismo `SUPABASE_JWT_SECRET` de `.env.test`". Ya no aplica: el proyecto verifica contra el JWKS de Supabase con llaves asimétricas, y la suite genera su propio par EC P-256 en memoria — `.env.test` no lleva ningún secret de firma.)*

### 6. Revisar personalmente T-L07 antes de darlo por cerrado

Es el test de concurrencia del `PUT` de asignación. Confirmar a mano que:
- Las dos llamadas salen con `Promise.all` **dentro de un solo `it()`**.
- Usan **conexiones distintas** del pool, no la misma.
- El `SELECT ... FOR UPDATE` está **antes** de leer la suma, dentro de la misma transacción.

Un T-L07 mal escrito pasa siempre y no prueba nada.

### 7. Revisar personalmente el grupo M (cierre) antes de darlo por cerrado

Es la unidad con más efectos colaterales. Confirmar a mano T-M03 (déficit arrastrado en categoría `reset`) y T-M14 (sin doble conteo en F3). Son los dos que, si están mal, producen números plausibles y equivocados.

### 8. Revisar personalmente el grupo S (captura tardía) antes de darlo por cerrado

Es el comportamiento nuevo de §2.3 y toca el flujo más común de la app. Confirmar a mano T-S05 (sin periodo abierto no se compensa **y no falla**), T-S08 (el reintento idempotente no duplica el ajuste) y T-S09 (la reversa neutraliza el compensatorio).

### 9. Extraer los fixtures de contrato antes de cerrar el loop 2

Los archivos de `test/fixtures/contract/` (§11.1) se generan **a partir de las respuestas reales**, no copiando el markdown a mano. Después se comparan contra los bloques de `API-CONTRACT.md` una sola vez, a ojo, y a partir de ahí T-R09 los mantiene sincronizados.

**Verificación:** existe un fixture por cada fila de la tabla de §11.1, y `npm run test:integration:api:domain` pasa con ellos.

### 10. Antes de desplegar: verificar los endpoints de escritura contra Supabase real

La suite corre contra Postgres local, que **no tiene RLS activa de forma efectiva** (§3.8). Contra Supabase, Prisma sigue conectando como `service_role` y la bypassa igual, así que el comportamiento debe ser idéntico — pero conviene confirmarlo con un `POST /transactions/expenses` real antes de dar la API por desplegada.

---

# 13. Formas fijadas — nombres exactos, no inferibles

El agente **no** puede renombrar nada de esta lista. Si algo no encaja, se corrige el documento, no el nombre.

**Rutas** — todas bajo `/api/v1`:

```
/me
/accounts                              /accounts/{id}/archive     /accounts/{id}/unarchive     /accounts/{id}/ledger
/categories                            /categories/{id}/archive   /categories/{id}/unarchive   /categories/{id}/ledger
/income-sources                        /income-sources/{id}/archive   /income-sources/{id}/unarchive
/transactions/expenses                 /transactions/incomes      /transactions/transfers
/transactions/loans                    /transactions/loan-repayments  /transactions/loan-write-offs
/transactions/opening-balances         /transactions/{id}/reversal
/periods                               /periods/current           /periods/{id}/close          /periods/{id}/close-preview
/periods/{id}/allocations              /periods/{id}/allocations/{categoryId}
/periods/{id}/allocations/move         /periods/{id}/allocations/{allocationId}
/recurring-templates                   /recurring-templates/{id}/confirm
/insights/account-balances             /insights/category-balances
/insights/unassigned-funds             /insights/unbudgeted-transactions   /insights/dashboard
```

**Módulos:** `ProfileModule`, `AccountsModule`, `CategoriesModule`, `TransactionsModule`, `BudgetModule`, `RecurringModule`, `InsightsModule`, `AccountsDataModule`, `QueriesModule`, `LedgerModule`.

**Interfaces y tokens de provider:** `IAccountRepository`, `IQueryRepository`, `ITransactionRepository`, `IBudgetPeriodRepository`, `IBudgetEntryRepository`, `IRecurringTemplateRepository`, `IProfileRepository`. El binding es siempre `{ provide: 'IXxxRepository', useClass: PrismaXxxRepository }`.

**Funciones puras de `entry-builders.ts`:** `buildExpenseEntries`, `buildIncomeEntries`, `buildTransferEntries`, `buildLoanEntries`, `buildLoanRepaymentEntries`, `buildLoanWriteOffEntries`, `buildOpeningBalanceEntries`, `buildReversalEntries`. En `budget-compensations.ts`: `buildBudgetCompensations`.

**Método de escritura de ledger:** `ITransactionRepository.createWithEntries()`. No `create`, no `save`, no `insert`.

**Excepciones y `code`:** los de §9.1. Un archivo por excepción, bajo `exceptions/` del módulo que la lanza; las transversales bajo `src/common/errors/`.

**Heredadas de `TASK-auth`, intocables:** `EnsureProfileExistsService.ensure`, `ProfileRow` (con `deleted_at`, `created_at`, `updated_at` en `snake_case`), `ProfileDeletedException`, `ErrorLogRepository.write`, los claims `sub` / `email`.

**Heredadas de `TASK-db`, intocables:** los nombres de modelo de Prisma (`Account`, `Transaction`, `Entry`, `BudgetPeriod`, `BudgetEntry`, `RecurringTemplate`), las firmas de `fn_account_balances`, `fn_category_balances`, `fn_unassigned_funds`, `fn_transactions_without_period`, y la función pura `nextDueOn`.

---

# 14. Estructura de archivos esperada

```
src/
  main.ts                                  ← + setGlobalPrefix('api/v1'); BigInt sigue en la línea 1
  app.module.ts                            ← + los 7 módulos de dominio y los 3 compartidos
  common/
    filters/global-exception.filter.ts     ← + campo `code`
    decorators/current-user.decorator.ts
    decorators/current-profile.decorator.ts
    interceptors/profile.interceptor.ts
    errors/domain.exception.ts
    errors/pg-error.ts
    errors/prisma-error.mapper.ts
    errors/{invalid-cursor,invalid-input,resource-in-use}.exception.ts
    idempotency/idempotency-key.decorator.ts
    idempotency/{missing,invalid}-idempotency-key.exception.ts
    pagination/{cursor.ts,cursor.dto.ts,offset.dto.ts,types.ts}
    validators/{is-cents-string,is-calendar-date}.validator.ts
    prisma/prisma.module.ts                ← solo si no existe ya
  shared/
    accounts-data/
      accounts-data.module.ts
      interfaces/account-repository.interface.ts
      repositories/prisma-account.repository.ts
      types.ts
    queries/
      queries.module.ts
      interfaces/query-repository.interface.ts
      repositories/prisma-query.repository.ts
      types.ts
    periods-data/
      periods-data.module.ts
      interfaces/budget-period-repository.interface.ts
      repositories/prisma-budget-period.repository.ts
      types.ts
    ledger/
      ledger.module.ts
      entry-builders.ts                    ⭐ puro
      budget-compensations.ts              ⭐ puro (§4.9)
      account-role.validator.ts            ⭐ puro
      interfaces/transaction-repository.interface.ts
      repositories/prisma-transaction.repository.ts
      exceptions/idempotency-in-flight.exception.ts
      types.ts
  profile/
    profile.module.ts · profile.controller.ts · profile.service.ts
    interfaces/profile-repository.interface.ts
    repositories/prisma-profile.repository.ts
    dto/{update-profile.dto.ts,profile-response.dto.ts}
    exceptions/invalid-timezone.exception.ts
  accounts/
    accounts.module.ts · accounts.controller.ts · accounts.service.ts
    dto/{create-account.dto.ts,update-account.dto.ts,list-accounts.query.ts,account-response.dto.ts}
    exceptions/{account-not-found,duplicate-account-name,account-not-empty,archive-state,currency-locked,archived-account,system-account}.exception.ts
  categories/
    categories.module.ts
    categories.controller.ts · income-sources.controller.ts
    categories.service.ts   · income-sources.service.ts
    dto/{create-category.dto.ts,update-category.dto.ts,list-categories.query.ts,category-response.dto.ts,create-income-source.dto.ts,update-income-source.dto.ts,income-source-response.dto.ts}
    exceptions/{category-not-found,income-source-not-found,category-has-allocations}.exception.ts
  transactions/
    transactions.module.ts · transactions.controller.ts · transactions.service.ts
    dto/{create-expense.dto.ts,create-income.dto.ts,create-transfer.dto.ts,create-loan.dto.ts,create-loan-repayment.dto.ts,create-loan-write-off.dto.ts,create-opening-balance.dto.ts,create-reversal.dto.ts,update-transaction.dto.ts,list-transactions.query.ts,transaction-response.dto.ts}
    exceptions/{transaction-not-found,invalid-account-role,split-mismatch,same-account,mixed-currency,unbalanced-transaction,invalid-reversal,reversal-date-locked,immutable-ledger,empty-opening-balance,ownership-mismatch}.exception.ts
  budget/
    budget.module.ts
    periods.controller.ts    · periods.service.ts
    allocations.controller.ts· allocations.service.ts
    close.service.ts
    interfaces/budget-entry-repository.interface.ts
    repositories/prisma-budget-entry.repository.ts
    (IBudgetPeriodRepository vive en src/shared/periods-data/, ver §6.8)
    dto/{create-period.dto.ts,update-period.dto.ts,list-periods.query.ts,period-response.dto.ts,create-allocation.dto.ts,set-allocation.dto.ts,move-allocation.dto.ts,allocation-response.dto.ts,close-preview-response.dto.ts,close-response.dto.ts}
    exceptions/{period-not-found,period-overlap,closed-period,next-period-required,earlier-period-open,period-not-empty,allocation-not-found,invalid-budget-category,duplicate-rollover,no-current-period,same-category-move}.exception.ts
  recurring/
    recurring.module.ts · recurring.controller.ts · recurring.service.ts
    interfaces/recurring-template-repository.interface.ts
    repositories/prisma-recurring-template.repository.ts
    dto/{create-template.dto.ts,update-template.dto.ts,confirm-template.dto.ts,list-templates.query.ts,template-response.dto.ts}
    exceptions/{recurring-template-not-found,payment-account-required}.exception.ts
  insights/
    insights.module.ts · insights.controller.ts · insights.service.ts
    dto/{account-balances-response.dto.ts,category-balances-response.dto.ts,unassigned-funds-response.dto.ts,unbudgeted-transactions-response.dto.ts,dashboard-response.dto.ts}

test/
  setup/fixture.ts                         ← extendido, nunca reemplazado
  fixtures/contract/*.json                 ← §11.1, versionados
  integration/
    auth/                                  ← sin tocar
    api/
      _helpers/{app.ts,auth.ts,seed.ts,normalize.ts}
      core/                                ← LOOP 1
        ledger-repository.integration.spec.ts
        queries-repository.integration.spec.ts
        accounts.integration.spec.ts
        categories.integration.spec.ts
        profile.integration.spec.ts
        errors.integration.spec.ts
        contract-static.integration.spec.ts
      domain/                              ← LOOP 2
        idempotency-http.integration.spec.ts
        transactions-expense.integration.spec.ts
        transactions-income-transfer.integration.spec.ts
        transactions-loans.integration.spec.ts
        transactions-opening-balance.integration.spec.ts
        transactions-reversal.integration.spec.ts
        transactions-query.integration.spec.ts
        late-capture.integration.spec.ts
        periods.integration.spec.ts
        allocations.integration.spec.ts
        period-close.integration.spec.ts
        recurring.integration.spec.ts
        insights.integration.spec.ts
        contract-fixtures.integration.spec.ts
    <archivos existentes de la capa de datos, sin mover>

  ⚠️ Ningún archivo de test suelto directamente en test/integration/api/.
     Los scripts filtran por core/ y domain/; un archivo fuera de esas dos
     carpetas no lo recoge ninguna condición de paro.

src/shared/ledger/entry-builders.spec.ts   ⭐ unit
src/common/pagination/cursor.spec.ts       ⭐ unit
src/common/errors/pg-error.spec.ts         ⭐ unit
src/common/validators/*.spec.ts            ⭐ unit

prisma/migrations/                         ← SIN CAMBIOS. Cero migraciones nuevas
```

**Los cuatro archivos `*.spec.ts` marcados ⭐ viven junto al código, no en `test/`**, porque son unitarios puros y los recoge `test:unit`. Los de integración viven todos en `test/integration/api/`.

---

# 15. Huecos detectados en la capa de datos

**Ninguno de estos se resuelve en esta tarea.** La capa de datos está cerrada y en verde. Se registran para decisión aparte.

| # | Hueco | Impacto hoy | Workaround aplicado |
|---|---|---|---|
| **H1** | **F2 no devuelve `rollover_type`.** `close-preview` y el cierre necesitan saber, por categoría, si el sobrante se arrastra o se libera. | Ninguno funcional. | Un `SELECT` extra a `accounts` desde el repository. **La función no se toca.** |
| **H2** | **No existe consulta de "transacciones de un periodo".** F4 responde lo contrario (las que no tienen periodo). | Ninguno. | Query directo con `booked_at BETWEEN` desde el repository. |
| **H3** | **No hay índice compuesto `(user_id, booked_at DESC, id)`.** La paginación por cursor desempata por `id`. | Ninguno a la escala de una app personal: `transactions_user_booked_idx` cubre el filtro y el desempate se resuelve en memoria sobre un conjunto ya pequeño. | Se documenta como observación, no como cambio pendiente. Reevaluar si un usuario supera ~50k transacciones. |
| **H4** | **`entries` no tiene índice ordenable por fecha.** `/accounts/{id}/ledger` filtra por `entries_user_account_idx` y ordena por `transactions.booked_at`, que llega por `JOIN`. | Ninguno a esta escala. | Igual que H3: observación. |
| **H5** | **No existe marca de onboarding completado.** §3.12 lo declaró fuera de alcance ("se maneja en UX"), pero el front necesita decidir si mostrar el flujo de alta. | El front tiene que derivarlo. | `GET /accounts` con cero cuentas `asset` es la señal. Documentado en `API-CONTRACT.md`. |
| **H6** | ~~Un gasto capturado con `bookedAt` en un periodo cerrado no se puede presupuestar.~~ **RESUELTO** por la compensación al periodo abierto actual (§2.3), que es el default que §3.10 ya documentaba. | — | Ya no es un hueco. Se conserva la fila por trazabilidad. |
| **H7** | **`budget_entries` no tiene forma de referenciar la transacción que lo originó.** No existe una columna `transaction_id`, y agregarla es un cambio de la capa de datos. | Real, acotado a **un solo** escenario: un compensatorio de captura tardía es indistinguible de una asignación manual salvo por el texto de su `note`, así que el usuario puede borrarlo con `DELETE /allocations/{id}` sin que nada lo impida, dejando el gasto sin cubrir en el periodo actual. *(El segundo escenario — reversa con `bookedAt` sobreescrito dejando el compensatorio huérfano — **ya no aplica**: se bloquea en el servidor con `422 REVERSAL_DATE_LOCKED`, ver §4.8 y T-S10.)* | La `note` con formato fijo (§4.9) permite identificarlos a ojo. Resolverlo de verdad exige una columna `transaction_id` en `budget_entries` — **es el candidato número uno para la próxima migración**, junto a los índices de H3 y H4. Decisión aparte. |

---

# 16. Fuera de alcance — no implementar

- Cualquier migración de base de datos.
- `POST /periods/{id}/reopen` y todo el algoritmo de reapertura (P-02). El escenario que resolvía se cubre por §2.3.
- Sembrado o creación automática de la categoría "Pérdidas" (P-03).
- Reactivación de un perfil con `deleted_at` no nulo (P-06).
- Multi-moneda (P-08). La validación de moneda única se pre-valida y punto.
- Tools del MCP (P-09).
- Cache (P-11).
- Rate limiting, modelo de roles, `McpConnection`, logging externo.
- `POST /recurring-templates/{id}/skip`.
- Tests de RLS.
- Frontend. `API-CONTRACT.md` es el único entregable dirigido a esa capa, y es un documento, no código.
