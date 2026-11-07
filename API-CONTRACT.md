# API-CONTRACT.md

> **Para quien construya el frontend.** Este documento es autosuficiente: se lee sin `ARCHITECTURE.md`, sin `TASK-db.md` y sin ver el código del backend. Describe **solo el contrato**: qué se manda, qué regresa, qué falla y por qué.
>
> **Estado:** v1. El backend puede estar todavía en implementación mientras se lee esto; el contrato ya está congelado.
>
> **Vocabulario:** los nombres de recursos, campos y valores de enum van en **inglés técnico**. El glosario en español de la interfaz (Sobre, Quincena, Disponible, Te deben…) es responsabilidad del frontend y **no** aparece en el JSON. El mapeo sugerido está en §17.

---

## 1. Qué modela esta API

Una app de **presupuesto personal por sobres**. Tres ideas bastan para usarla:

1. **Accounts** — dónde está el dinero: efectivo, banco, tarjeta de crédito, y dinero que alguien te debe.
2. **Categories** — sobres de presupuesto. A cada uno se le asigna dinero por periodo y contra él se gasta.
3. **Periods** — quincenas (o el rango que el usuario defina). Se abren, se les asigna presupuesto, y se cierran. Al cerrar, el sobrante de cada sobre se arrastra o se libera según su configuración.

**La API expone intenciones, no mecánica contable.** No se registra "un movimiento en la cuenta A y otro en la cuenta B": se registra *un gasto*, *un ingreso*, *una transferencia*, *un préstamo*. El backend traduce. **Ningún endpoint acepta un arreglo de movimientos como entrada.**

---

## 2. Base URL y versionado

```
https://<host>/api/v1
```

Todas las rutas de este documento son relativas a esa base. `/accounts` significa `GET https://<host>/api/v1/accounts`.

La versión está en la ruta desde el día uno. Un cambio incompatible sube a `/api/v2`; dentro de `v1` solo se agregan campos opcionales.

---

## 3. Autenticación

**Todos** los endpoints requieren un JWT de Supabase Auth:

```
Authorization: Bearer <access_token>
```

El login, el signup y el refresh **no pasan por esta API**: los hace el frontend directamente contra Supabase Auth (`@supabase/ssr`), con la sesión en cookies httpOnly. El token se refresca solo mientras el refresh token siga vigente.

| Situación | Respuesta |
|---|---|
| Sin header `Authorization` | `401` · `UNAUTHORIZED` |
| Token mal formado, inválido o expirado | `401` · `UNAUTHORIZED` |
| Perfil dado de baja | `403` · `PROFILE_DELETED` |

**Qué hacer ante un `401`:** el refresh automático de `@supabase/ssr` cubre la mayoría de los casos. Cuando falla (revocación, refresh token vencido, red), llega el `401`. El frontend debe:

- Mantener el estado de los formularios **fuera** del ciclo de sesión, para no perder lo capturado.
- Detectar el `401` específicamente y pedir re-login.
- Rehidratar el formulario después y reintentar.

**El usuario nunca se manda como parámetro.** No existe ningún campo `userId` en ningún request. El backend lo saca del token. Un request que incluya `userId` recibe `400`.

---

## 4. Convenciones

### 4.1 Montos — siempre string

**Todo monto viaja como string de centavos enteros**, en entrada y en salida. Nunca como número.

```json
{ "amountCents": "70000" }     // $700.00
{ "amountCents": "-250000" }   // -$2,500.00
{ "amountCents": "0" }
```

**Por qué string.** Son enteros de 64 bits. `JSON.parse` de JavaScript los convertiría a `Number` y perdería precisión arriba de 2^53. Un saldo grande se corrompería en silencio.

**Formato aceptado en entrada:** `/^-?\d{1,19}$/`. Sin punto decimal, sin separadores de miles, sin símbolo de moneda, sin notación científica. `"700.00"`, `"1,000"`, `"$700"` y `7e3` son todos `400`.

**En el frontend:** trabaja siempre en centavos. La división entre 100 vive en **un solo** helper `formatMoney(cents)` que se llama en el momento exacto de pintar. Ningún estado, ningún cálculo, ningún form value debe estar en unidades.

**Todo campo que termina en `Cents` es un string.** Sin excepción.

### 4.2 Fechas

| Tipo | Formato | Campos |
|---|---|---|
| **Fecha de calendario** | `YYYY-MM-DD` | `bookedAt`, `startsOn`, `endsOn`, `nextDueOn`, `lastConfirmedOn` |
| **Instante** | RFC 3339 en UTC, con `Z` | `createdAt`, `updatedAt`, `closedAt`, `archivedAt` |

**`bookedAt` es una fecha local, no un instante.** El frontend la resuelve **antes** de mandarla, en la zona del usuario. El servidor no convierte nada.

**Por qué importa:** un gasto capturado a las 23:00 en CDMX, mandado como instante UTC, se guardaría como las 05:00 del día siguiente y caería en la quincena equivocada. Manda `"2026-08-09"`, no `"2026-08-10T05:00:00Z"`.

**Zona horaria del usuario:** `GET /me` devuelve `timezone` (string IANA, ej. `"America/Mexico_City"`). Úsala para calcular "hoy" y para pintar los instantes en hora local. Nunca uses la zona del navegador sin confirmar que coincide.

### 4.3 Nulos

- **En entrada:** un campo opcional ausente y un campo en `null` significan lo mismo.
- **En salida:** un campo nulo se emite **explícitamente** como `null`. Nunca se omite. No hay que distinguir "no aplica" de "no vino".

### 4.4 Identificadores

Todos los `id` son UUID en string. Se generan del lado del servidor. El cliente nunca los inventa — salvo el `Idempotency-Key`, que es otra cosa (§5).

### 4.5 `kind` y la regla de signo

Cada cuenta, sobre y fuente de ingreso tiene un `kind`:

| `kind` | Qué es | Saldo natural | Cómo pintarlo |
|---|---|---|---|
| `cash` | Dinero propio disponible: banco, efectivo, débito | Positivo | Tal cual |
| `credit` | Tarjeta de crédito: deuda propia | **Negativo** | Valor absoluto, etiqueta "debes" |
| `receivable` | Dinero que alguien te debe | Positivo | Tal cual, etiqueta "te deben" |
| `category` | Un sobre de presupuesto | Positivo | Tal cual — es el gasto acumulado |
| `income_source` | Una fuente de ingreso | **Negativo** | Valor absoluto |

**La API devuelve el monto crudo con signo. El frontend aplica la tabla.**

**Regla dura:** la transformación depende **exclusivamente** del `kind`. Nunca del nombre de la cuenta, nunca del contexto de la pantalla. Un saldo de `credit` en `"-250000"` se pinta como `$2,500.00 debes`, siempre, en cualquier pantalla.

**El signo crudo nunca se muestra al usuario final.**

Existe un sexto `kind`, `system`, que la API **nunca devuelve** en ningún listado. Solo puede aparecer, y de forma marginal, en el detalle de una transacción de saldo inicial. Si aparece, se omite de la UI.

### 4.6 Monedas

`currency` es ISO 4217 en mayúsculas. El default al crear es `"MXN"`.

**Una transacción no puede mezclar monedas.** Si las cuentas involucradas tienen `currency` distinta, la operación falla con `422 MIXED_CURRENCY`. No hay conversión, no hay tipo de cambio: es multi-moneda a nivel de cuenta, no de transacción.

**La moneda de una cuenta con movimientos no se puede cambiar** (`409 CURRENCY_LOCKED`).

---

## 5. Idempotencia

Nueve endpoints crean movimientos de dinero. **Los nueve exigen el header:**

```
Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000
```

Un UUID v4. En cualquier otro endpoint el header se ignora.

**Endpoints que lo exigen:**

```
POST /transactions/expenses
POST /transactions/incomes
POST /transactions/transfers
POST /transactions/loans
POST /transactions/loan-repayments
POST /transactions/loan-write-offs
POST /transactions/opening-balances
POST /transactions/{id}/reversal
POST /recurring-templates/{id}/confirm
```

### 5.1 La regla crítica del cliente

**Genera el UUID una sola vez por *intención del usuario*, no por intento HTTP.** Si el usuario aprieta "Guardar" y la red se corta, el reintento debe llevar **la misma** llave. Si generas una llave nueva por cada `fetch`, el mecanismo no sirve de nada y vas a duplicar transacciones.

En la práctica: genera el UUID cuando se abre el formulario o cuando se dispara el submit, guárdalo en el estado, y consérvalo a través de todos los reintentos hasta recibir un `2xx`.

### 5.2 Qué devuelve cada caso

| Situación | Status | Cuerpo |
|---|---|---|
| Llave nueva → se creó | `201` | El recurso creado |
| Llave ya usada, se recupera | `200` | **Exactamente el mismo cuerpo** que la primera vez |
| Llave ya usada, la escritura original sigue en vuelo | `409` · `IDEMPOTENCY_IN_FLIGHT` + `Retry-After: 1` | Error |
| Falta el header | `400` · `IDEMPOTENCY_KEY_REQUIRED` | Error |
| El header no es un UUID | `400` · `IDEMPOTENCY_KEY_INVALID` | Error |

**`201` vs `200` es el único diferenciador entre "se creó" y "ya existía".** El cuerpo es idéntico. No hay ninguna otra señal, y no hace falta.

**Ante `IDEMPOTENCY_IN_FLIGHT`:** espera ~1 segundo y reintenta **con la misma llave**. No es un error del usuario ni una falla: dos requests con la misma llave llegaron casi al mismo tiempo y el primero todavía no termina de escribir. El reintento devolverá `200` con la transacción.

**Si mandas la misma llave con un body distinto**, recibes `200` con la transacción **original**. La llave manda sobre el body. No uses una llave para dos intenciones distintas.

---

## 6. Paginación

### 6.1 Cursor — historiales

Aplica a `/transactions`, `/accounts/{id}/ledger` y `/categories/{id}/ledger`. Son listas que crecen sin límite.

**Request:** `?limit=50&cursor=<opaco>`

- `limit`: default `50`, máximo `100`.
- `cursor`: se toma tal cual del `nextCursor` de la página anterior. **Trátalo como opaco**: no lo parsees, no lo construyas, no lo guardes entre sesiones.

**Response:**

```json
{
  "data": [ /* ... */ ],
  "nextCursor": "eyJiIjoiMjAyNi0wOC0wOSIsInQiOiI4ZjFjLi4uIn0"
}
```

`nextCursor` es `null` **solo** cuando no hay más páginas. Un array `data` vacío con `nextCursor` no nulo no ocurre.

El orden es fijo: **más reciente primero**, por `bookedAt` descendente. No es configurable.

Un cursor mal formado devuelve `400 INVALID_CURSOR` — nunca se ignora en silencio.

### 6.2 Offset — listas acotadas

Todo lo demás: cuentas, sobres, fuentes de ingreso, periodos, plantillas recurrentes.

**Request:** `?page=1&pageSize=50` — `page` empieza en 1, `pageSize` máximo `200`.

**Response:**

```json
{ "data": [ /* ... */ ], "page": 1, "pageSize": 50, "total": 12 }
```

---

## 7. Errores

### 7.1 Formato

**Todo** error tiene esta forma, sin importar la capa que lo produjo:

```json
{
  "statusCode": 409,
  "code": "PERIOD_CLOSED",
  "message": "El periodo está cerrado y sus asignaciones no se pueden modificar.",
  "timestamp": "2026-08-09T18:22:41.108Z",
  "path": "/api/v1/periods/8f1c.../allocations"
}
```

**Programa contra `code`, nunca contra `message`.** El `message` está pensado para leerse en un log o mostrarse como fallback; puede cambiar de redacción sin aviso. `code` es contrato.

Los errores de validación agregan `details`:

```json
{
  "statusCode": 400,
  "code": "VALIDATION_FAILED",
  "message": "La petición no pasó validación.",
  "details": [
    { "field": "totalCents", "constraint": "must be a string of integer cents" },
    { "field": "bookedAt",   "constraint": "must match YYYY-MM-DD" }
  ],
  "timestamp": "...",
  "path": "..."
}
```

**Nunca** se expone stack trace, SQL, ni mensaje interno de base de datos. Un error inesperado llega como `500` · `INTERNAL_ERROR` con un `message` genérico.

### 7.2 Catálogo de códigos

**400 — la petición está mal formada**

| `code` | Significa |
|---|---|
| `VALIDATION_FAILED` | Un campo falta, tiene formato inválido, o mandaste un campo que no existe. Ver `details` |
| `IDEMPOTENCY_KEY_REQUIRED` | Falta el header en un endpoint que lo exige |
| `IDEMPOTENCY_KEY_INVALID` | El header no es un UUID |
| `INVALID_CURSOR` | El cursor no se pudo decodificar |
| `INVALID_TIMEZONE` | El string no es una zona IANA válida |

**401 / 403 — identidad y permisos**

| `code` | Significa |
|---|---|
| `UNAUTHORIZED` | Sin token, o token inválido/expirado |
| `PROFILE_DELETED` | El perfil está dado de baja |
| `SYSTEM_ACCOUNT_NOT_ADDRESSABLE` | Mandaste el id de una cuenta interna del sistema. No es direccionable |
| `OWNERSHIP_MISMATCH` | Inconsistencia de propiedad detectada por el backend. No debería ocurrir |

**404 — no existe, o no es tuyo**

`ACCOUNT_NOT_FOUND` · `CATEGORY_NOT_FOUND` · `INCOME_SOURCE_NOT_FOUND` · `TRANSACTION_NOT_FOUND` · `PERIOD_NOT_FOUND` · `ALLOCATION_NOT_FOUND` · `RECURRING_TEMPLATE_NOT_FOUND` · `NO_CURRENT_PERIOD`

**Un recurso de otro usuario devuelve `404`, no `403`.** La API no confirma la existencia de nada ajeno.

**409 — el estado del recurso no permite la operación**

| `code` | Significa | Qué hacer |
|---|---|---|
| `IDEMPOTENCY_IN_FLIGHT` | La escritura con esa llave sigue en vuelo | Esperar 1s y reintentar con la misma llave |
| `DUPLICATE_ACCOUNT_NAME` | Ya existe una cuenta, sobre o fuente activa con ese nombre | Pedir otro nombre |
| `ACCOUNT_NOT_EMPTY` | Intentaste archivar una cuenta con saldo distinto de cero | Saldar o transferir primero |
| `ACCOUNT_ARCHIVED` | La cuenta está archivada; no admite movimientos nuevos | Desarchivar o elegir otra |
| `ALREADY_ARCHIVED` / `NOT_ARCHIVED` | Archivar lo archivado, o desarchivar lo activo | Refrescar el estado |
| `CURRENCY_LOCKED` | La cuenta ya tiene movimientos; su moneda no se cambia | — |
| `CATEGORY_HAS_ALLOCATIONS` | El sobre tiene presupuesto asignado en un periodo abierto | Quitar la asignación primero |
| `ALREADY_REVERSED` | Esa transacción ya tiene una reversa | — |
| `CANNOT_REVERSE_REVERSAL` | Intentaste revertir una reversa | Registrar una transacción nueva |
| `IMMUTABLE_LEDGER` | Intento de modificar o borrar algo inmutable | Usar la reversa |
| `PERIOD_OVERLAP` | El rango se traslapa con otro periodo | Ajustar las fechas |
| `PERIOD_CLOSED` | El periodo está cerrado | — (ver §15.1) |
| `PERIOD_ALREADY_CLOSED` | Doble cierre | Refrescar |
| `NEXT_PERIOD_REQUIRED` | No existe el periodo siguiente y el cierre lo necesita | Crear el periodo siguiente y reintentar |
| `NEXT_PERIOD_CLOSED` | El periodo siguiente ya está cerrado | — (ver §15.2) |
| `EARLIER_PERIOD_OPEN` | Hay un periodo anterior sin cerrar | Cerrar los periodos en orden cronológico |
| `PERIOD_NOT_EMPTY` | El periodo tiene asignaciones y no se puede borrar | Borrar las asignaciones primero |
| `DUPLICATE_ROLLOVER` | Dos cierres concurrentes del mismo periodo | Refrescar |
| `RESOURCE_IN_USE` | El recurso está referenciado por otro | — |

**422 — la petición es coherente pero el contenido no es válido para el dominio**

| `code` | Significa |
|---|---|
| `INVALID_ACCOUNT_ROLE` | Mandaste una cuenta donde no corresponde su tipo: p.ej. pagar desde un sobre, o transferir hacia un sobre |
| `SPLIT_TOTAL_MISMATCH` | Las partes del gasto no suman el total |
| `SAME_ACCOUNT_TRANSFER` / `SAME_CATEGORY_MOVE` | Origen y destino son el mismo |
| `EMPTY_OPENING_BALANCE` | Ningún saldo distinto de cero |
| `PAYMENT_ACCOUNT_REQUIRED` | Confirmaste un recurrente sin cuenta de pago ni en el body ni en la plantilla |
| `REVERSAL_DATE_LOCKED` | Mandaste `bookedAt` al revertir una transacción que había generado un ajuste de captura tardía. Omite el campo |
| `MIXED_CURRENCY` | Se mezclaron monedas distintas |
| `INVALID_BUDGET_CATEGORY` | El id no corresponde a un sobre |
| `UNBALANCED_TRANSACTION` / `INVALID_REVERSAL` | Errores internos de consistencia. No deberían ocurrir |
| `INVALID_INPUT` | Violación de una restricción de dominio no cubierta arriba |

**500**

`INTERNAL_ERROR` — error no controlado. Reintentar no ayuda; reportar.

---

## 8. Profile

### `GET /me`

```json
{
  "userId": "3f2b9c14-5d8e-4a71-9b02-1c6ea7d84f30",
  "email": "luis@example.com",
  "timezone": "America/Mexico_City",
  "createdAt": "2026-07-14T02:11:03.000Z",
  "updatedAt": "2026-08-01T19:40:12.000Z"
}
```

El default de `timezone` es `"America/Mexico_City"`. Nunca es `null`.

### `PATCH /me`

```json
{ "timezone": "America/Monterrey" }
```

`200` con el perfil actualizado. Se valida contra la lista IANA real; un valor inventado da `400 INVALID_TIMEZONE`.

---

## 9. Accounts

Cuentas reales: dónde está el dinero. `kind ∈ { cash, credit, receivable }`.

**Forma del recurso:**

```json
{
  "id": "8f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f",
  "name": "Nu",
  "kind": "cash",
  "currency": "MXN",
  "balanceCents": "1000000",
  "archivedAt": null,
  "createdAt": "2026-07-14T02:11:03.000Z",
  "updatedAt": "2026-08-01T19:40:12.000Z"
}
```

### `GET /accounts`

Query: `kind?`, `includeArchived?` (default `false`), `page?`, `pageSize?`.

```json
{
  "data": [
    { "id": "8f1c...", "name": "Nu",            "kind": "cash",       "currency": "MXN", "balanceCents": "1000000",  "archivedAt": null, "createdAt": "...", "updatedAt": "..." },
    { "id": "a2b3...", "name": "TDC BBVA",      "kind": "credit",     "currency": "MXN", "balanceCents": "-250000",  "archivedAt": null, "createdAt": "...", "updatedAt": "..." },
    { "id": "c4d5...", "name": "Fer me debe",   "kind": "receivable", "currency": "MXN", "balanceCents": "50000",    "archivedAt": null, "createdAt": "...", "updatedAt": "..." }
  ],
  "page": 1, "pageSize": 50, "total": 3
}
```

**Archivadas excluidas por default.** Este es el **único** lugar donde archivar cambia lo que se ve: los totales y los cálculos de presupuesto siguen incluyendo cuentas archivadas siempre.

**Cero cuentas `cash` significa que el usuario no ha terminado el onboarding.** No hay un flag de onboarding; esta es la señal.

### `POST /accounts`

```json
{ "name": "Efectivo", "kind": "cash", "currency": "MXN" }
```

`201` con el recurso. `currency` es opcional (default `"MXN"`).

Errores: `409 DUPLICATE_ACCOUNT_NAME`, `400 VALIDATION_FAILED`.

**El nombre es único entre TODAS las cuentas activas del usuario**, incluidos sobres y fuentes de ingreso. No pueden coexistir un sobre "Salud" y una cuenta "Salud". La comparación **ignora mayúsculas**: `"nu"` choca con `"Nu"`.

### `GET /accounts/{id}` · `PATCH /accounts/{id}`

`PATCH` acepta `name` y `currency`. Nada más.

```json
{ "name": "Nu — principal" }
```

Errores: `404`, `409 DUPLICATE_ACCOUNT_NAME`, `409 CURRENCY_LOCKED`.

### `POST /accounts/{id}/archive` · `POST /accounts/{id}/unarchive`

Sin body. `200` con el recurso.

**Archivar exige saldo exactamente cero** en `cash`, `credit` y `receivable` → si no, `409 ACCOUNT_NOT_EMPTY`. Archivar una cuenta con dinero la desaparecería de la lista mientras su saldo sigue contando en los totales, produciendo una diferencia inexplicable.

Una cuenta archivada **no admite movimientos nuevos** (`409 ACCOUNT_ARCHIVED`), pero sigue contando en todos los saldos y sigue apareciendo en `/insights/account-balances`.

### `GET /accounts/{id}/ledger`

Movimientos de esa cuenta. Cursor. Query: `limit?`, `cursor?`.

```json
{
  "data": [
    {
      "transactionId": "9a8b...",
      "bookedAt": "2026-08-09",
      "description": "Wifi agosto",
      "amountCents": "-70000",
      "createdAt": "2026-08-09T21:14:02.331Z"
    }
  ],
  "nextCursor": null
}
```

`amountCents` es el efecto **sobre esta cuenta**, con signo: negativo salió, positivo entró.

---

## 10. Categories e Income sources

### 10.1 Categories — los sobres

```json
{
  "id": "b1c2...",
  "name": "Comida",
  "kind": "category",
  "rolloverType": "reset",
  "currency": "MXN",
  "balanceCents": "125000",
  "archivedAt": null,
  "createdAt": "...", "updatedAt": "...",
  "period": null
}
```

`balanceCents` es el **gasto acumulado histórico** de ese sobre, positivo.

**`rolloverType`** define qué pasa con el sobrante al cerrar un periodo:

| Valor | Al cerrar, si sobró dinero |
|---|---|
| `accumulate` | El sobrante **se arrastra** al periodo siguiente |
| `reset` | El sobrante **se libera** y vuelve al dinero por asignar |

**El déficit siempre se arrastra**, sin importar el `rolloverType`. `reset` significa "el sobrante no se acumula", no "la deuda se perdona": ese dinero ya se gastó.

Es obligatorio al crear y editable en cualquier momento. Cambiarlo solo afecta cierres futuros.

#### `GET /categories`

Query: `periodId?`, `includeArchived?`, `page?`, `pageSize?`.

**Con `periodId`** cada sobre incluye el bloque `period`:

```json
{
  "data": [
    {
      "id": "b1c2...", "name": "Comida", "kind": "category", "rolloverType": "reset",
      "currency": "MXN", "balanceCents": "125000", "archivedAt": null,
      "createdAt": "...", "updatedAt": "...",
      "period": {
        "periodId": "d3e4...",
        "assignedCents": "200000",
        "spentCents": "50000",
        "availableCents": "150000",
        "hasBudget": true,
        "status": "available"
      }
    },
    {
      "id": "f5a6...", "name": "Salud", "kind": "category", "rolloverType": "accumulate",
      "currency": "MXN", "balanceCents": "30000", "archivedAt": null,
      "createdAt": "...", "updatedAt": "...",
      "period": {
        "periodId": "d3e4...",
        "assignedCents": "0",
        "spentCents": "30000",
        "availableCents": "-30000",
        "hasBudget": false,
        "status": "no_budget"
      }
    }
  ],
  "page": 1, "pageSize": 50, "total": 7
}
```

**`status` y por qué `hasBudget` no es redundante:**

| `status` | Condición | Qué mostrar |
|---|---|---|
| `no_budget` | `hasBudget = false` | **"Sin presupuesto"** — no es "disponible en cero" ni "sobregiro" |
| `available` | `availableCents > 0` | Disponible |
| `depleted` | `availableCents = 0` y `hasBudget = true` | Agotado |
| `overspent` | `availableCents < 0` y `hasBudget = true` | **Sobregiro** — mostrar en negativo, con aviso |

`hasBudget` sale del **conteo** de asignaciones, no del monto. Dos asignaciones de `+50000` y `−50000` dan `assignedCents: "0"` **con** `hasBudget: true`: sí hubo presupuesto, quedó en cero. Es distinto de nunca haber asignado nada.

**Sugerir cobertura de un sobregiro:** filtra los sobres del mismo periodo con `availableCents > 0`, ordénalos descendente, y ofrece `POST /periods/{id}/allocations/move`. No hace falta ningún endpoint extra.

**Sin `periodId`**, `period` viene en `null` y solo tienes el acumulado histórico.

**Los sobres archivados a media quincena siguen apareciendo con su gasto real del periodo** cuando pides `periodId`. No desaparecen del reporte.

#### `POST /categories`

```json
{ "name": "Mascotas", "rolloverType": "accumulate", "currency": "MXN" }
```

`rolloverType` es **obligatorio**.

#### `PATCH /categories/{id}`

Acepta `name` y `rolloverType`.

#### `POST /categories/{id}/archive` · `/unarchive`

Un sobre **sí** se puede archivar con gasto acumulado — su saldo es un histórico que nunca vuelve a cero por diseño, y archivarlo solo lo retira de la lista de asignación futura. Su historial permanece intacto.

**Pero no se puede archivar si tiene presupuesto asignado en un periodo abierto** → `409 CATEGORY_HAS_ALLOCATIONS`. Dinero apartado en un sobre invisible seguiría restando del dinero por asignar sin que el usuario pueda verlo. Quita la asignación primero.

Si sus únicas asignaciones están en periodos ya cerrados, se archiva sin problema.

#### `GET /categories/{id}/ledger`

Todo lo gastado en ese sobre. Misma forma que `/accounts/{id}/ledger`, cursor.

### 10.2 Income sources — fuentes de ingreso

```json
{
  "id": "e7f8...",
  "name": "Sueldo",
  "kind": "income_source",
  "currency": "MXN",
  "balanceCents": "-1000000",
  "archivedAt": null,
  "createdAt": "...", "updatedAt": "..."
}
```

**`balanceCents` es negativo**: es el acumulado histórico recibido. Aplica la regla de §4.5 — se pinta en valor absoluto.

Endpoints: `GET /income-sources`, `POST /income-sources` (`{ "name": "Freelance", "currency": "MXN" }`), `GET`/`PATCH /income-sources/{id}`, `POST /income-sources/{id}/archive` y `/unarchive`.

**No tienen `rolloverType`.** Mandarlo da `400`.

### 10.3 Qué trae un usuario nuevo

Al crearse la cuenta se siembra automáticamente, y **solo**, la infraestructura que el usuario no puede crear por su cuenta:

- **La cuenta de sistema** — interna, nunca visible ni direccionable. Sostiene `POST /transactions/opening-balances`.

**Cero sobres, cero fuentes de ingreso, cero cuentas reales.**

Los 7 sobres sugeridos y la fuente de ingreso "Sueldo" **no se siembran**: preséntalos como lista sugerida en el onboarding, con checkboxes preseleccionados, y créalos con `POST /categories` y `POST /income-sources` según lo que el usuario elija.

| Sobre sugerido | `rolloverType` sugerido |
|---|---|
| Comida | `reset` |
| Transporte | `reset` |
| Servicios | `accumulate` |
| Hogar | `reset` |
| Salud | `accumulate` |
| Personal | `reset` |
| Ahorro | `accumulate` |

Fuente de ingreso sugerida: **Sueldo**.

El onboarding también tiene que crear al menos una cuenta `cash` antes de que sea posible registrar cualquier transacción.

---

## 11. Transactions

**Siete intenciones distintas, siete endpoints.** No hay un endpoint genérico. Elige el que corresponde a lo que el usuario hizo, y el backend arma el movimiento correcto.

**Todos exigen `Idempotency-Key`** y responden `201` (creado) o `200` (recuperado por idempotencia), con el mismo cuerpo:

```json
{
  "id": "9a8b7c6d-5e4f-3a2b-1c0d-9e8f7a6b5c4d",
  "bookedAt": "2026-08-09",
  "description": "Wifi agosto",
  "totalCents": "70000",
  "reversesTransactionId": null,
  "createdAt": "2026-08-09T21:14:02.331Z",
  "budgetImpact": {
    "status": "in_open_period",
    "closedPeriodId": null,
    "compensatedInPeriodId": null,
    "compensations": []
  }
}
```

**La respuesta de creación no incluye el detalle de los movimientos**, a propósito. Si necesitas mostrarlo, pídelo con `GET /transactions/{id}`. Si lo que necesitas son saldos actualizados, pide `GET /insights/account-balances` o `GET /insights/dashboard`.

`totalCents` es el monto total movido por la transacción, siempre positivo.

### `budgetImpact` — qué pasó con el presupuesto

Presente en las siete intenciones, en la reversa y dentro de `transaction` en la confirmación de un recurrente.

| `status` | Significa | Qué mostrar |
|---|---|---|
| `in_open_period` | La fecha cae en una quincena abierta. Todo normal | Nada |
| `no_period` | La fecha no cae en ninguna quincena | Aviso suave: la transacción aparecerá en "pendientes de asignar" |
| `compensated` | La fecha cae en una quincena **cerrada**, y el impacto se aplicó a la quincena abierta actual | Explicar el ajuste — ver §11.12 |
| `uncompensated` | La fecha cae en una quincena cerrada y **no hay** quincena abierta que cubra hoy, así que no se pudo ajustar | Aviso: el gasto afecta el saldo pero no ninguna quincena. Sugerir crear la quincena actual |

Cuando `status` es `compensated`:

```json
"budgetImpact": {
  "status": "compensated",
  "closedPeriodId": "d3e4...",
  "compensatedInPeriodId": "aa77...",
  "compensations": [
    { "categoryId": "b1c2...", "categoryName": "Comida", "amountCents": "-50000" }
  ]
}
```

`compensations` trae una entrada **por categoría afectada**. Los montos son el ajuste aplicado, con signo.

### 11.1 `POST /transactions/expenses` — registrar un gasto

```json
{
  "bookedAt": "2026-08-09",
  "description": "Wifi agosto",
  "paidFromAccountId": "a2b3...",
  "totalCents": "70000",
  "lines": [
    { "categoryId": "b1c2...", "amountCents": "70000" }
  ]
}
```

- `paidFromAccountId` → `kind` `cash` o `credit`.
- `lines[].categoryId` → `kind` `category`. Al menos una línea.
- **`sum(lines) + sum(lentTo) debe ser exactamente `totalCents`.**

**Gasto repartido entre varios sobres:**

```json
{
  "bookedAt": "2026-08-09",
  "description": "Súper",
  "paidFromAccountId": "8f1c...",
  "totalCents": "120000",
  "lines": [
    { "categoryId": "b1c2...", "amountCents": "90000" },
    { "categoryId": "aa11...", "amountCents": "30000" }
  ]
}
```

**Gasto donde parte se la prestaste a alguien** — cena de $800 con tarjeta, la mitad la puso Fer:

```json
{
  "bookedAt": "2026-08-09",
  "description": "Cena con Fer",
  "paidFromAccountId": "a2b3...",
  "totalCents": "80000",
  "lines":  [ { "categoryId": "b1c2...",           "amountCents": "40000" } ],
  "lentTo": [ { "receivableAccountId": "c4d5...", "amountCents": "40000" } ]
}
```

Solo $400 cuentan como tu gasto en Comida; los otros $400 quedan como dinero que Fer te debe.

**Reparto equitativo y redondeo:** si divides un monto entre N partes, **la suma de las partes tiene que dar exactamente el total**. El residuo de la división entera se asigna a una de las partes (típicamente la primera); **nunca se descarta**. `$100.00 / 3` es `3334 + 3333 + 3333`, no `3333 × 3`. Descartar el residuo produce `422 SPLIT_TOTAL_MISMATCH`.

Errores: `422 SPLIT_TOTAL_MISMATCH`, `422 INVALID_ACCOUNT_ROLE`, `422 MIXED_CURRENCY`, `409 ACCOUNT_ARCHIVED`, `404`.

### 11.2 `POST /transactions/incomes` — registrar un ingreso

```json
{
  "bookedAt": "2026-08-01",
  "description": "Quincena agosto",
  "toAccountId": "8f1c...",
  "sourceId": "e7f8...",
  "amountCents": "1000000"
}
```

`toAccountId` → `cash` o `credit`. `sourceId` → `income_source`.

### 11.3 `POST /transactions/transfers` — mover dinero entre cuentas

```json
{
  "bookedAt": "2026-08-05",
  "description": "Pago tarjeta",
  "fromAccountId": "8f1c...",
  "toAccountId": "a2b3...",
  "amountCents": "70000"
}
```

Ambas cuentas `cash` o `credit`.

> ### ⚠️ El pago de tarjeta de crédito es una transferencia
>
> **No es un gasto y no toca ningún sobre.** El gasto ya se contabilizó cuando se hizo la compra con la tarjeta. Registrarlo otra vez al pagar el estado de cuenta lo cuenta **dos veces** y descuadra todo el presupuesto.
>
> Es el error más común de este dominio. Si la UI ofrece "pagar tarjeta", que llame a `/transfers`, nunca a `/expenses`.

Errores adicionales: `422 SAME_ACCOUNT_TRANSFER`, `422 INVALID_ACCOUNT_ROLE` (si mandas un sobre como destino).

### 11.4 `POST /transactions/loans` — prestar dinero

```json
{
  "bookedAt": "2026-08-03",
  "description": "Préstamo a Fer",
  "fromAccountId": "8f1c...",
  "receivableAccountId": "c4d5...",
  "amountCents": "50000"
}
```

**Prestar no es gastar.** El dinero solo cambió de forma: dejó de estar disponible y pasó a ser dinero que te deben. No toca ningún sobre, pero **sí baja tu dinero por asignar**, porque no lo puedes presupuestar hoy.

### 11.5 `POST /transactions/loan-repayments` — te pagaron

```json
{
  "bookedAt": "2026-08-20",
  "description": "Fer me pagó",
  "receivableAccountId": "c4d5...",
  "toAccountId": "8f1c...",
  "amountCents": "50000"
}
```

**Se permiten cobros parciales**, y también cobrar de más: el saldo del `receivable` queda en negativo, que es un estado visible y corregible con una reversa. La API no lo bloquea.

### 11.6 `POST /transactions/loan-write-offs` — dar un préstamo por perdido

```json
{
  "bookedAt": "2026-09-30",
  "description": "Fer no va a pagar",
  "receivableAccountId": "c4d5...",
  "categoryId": "cc99...",
  "amountCents": "50000"
}
```

**Este es el único momento en que un préstamo impacta el presupuesto.** El saldo pendiente se salda contra un sobre de gasto y se refleja como gasto real del periodo en que se declaró.

**`categoryId` lo eliges tú.** La API **no** crea ni asume una categoría de "Pérdidas". Si tu UI quiere ofrecer una por default, la crea con `POST /categories` como cualquier otra.

### 11.7 `POST /transactions/opening-balances` — saldos iniciales

Para el onboarding: capturar cuánto hay en cada cuenta al empezar a usar la app.

```json
{
  "bookedAt": "2026-07-14",
  "description": "Saldos iniciales",
  "balances": [
    { "accountId": "8f1c...", "balanceCents": "1000000"  },
    { "accountId": "a2b3...", "balanceCents": "-250000"  },
    { "accountId": "ee55...", "balanceCents": "80000"    }
  ]
}
```

- **Los saldos llevan signo natural:** `cash` y `receivable` positivos, `credit` negativo.
- Los saldos en `"0"` se ignoran.
- Solo cuentas, no sobres ni fuentes de ingreso.
- **Se puede llamar más de una vez.** Si el usuario agrega una cuenta seis meses después, captura su saldo así.

Errores: `422 EMPTY_OPENING_BALANCE` (ningún saldo distinto de cero), `422 INVALID_ACCOUNT_ROLE`.

### 11.8 `POST /transactions/{id}/reversal` — corregir un error

```json
{ "description": "Corrección: monto equivocado" }
```

Ambos campos opcionales. `bookedAt` por default hereda la fecha del original, para que la corrección caiga en el mismo periodo.

> ### ⚠️ No existe editar ni borrar una transacción
>
> **La reversa es el único camino de corrección.** No hay `DELETE`, no hay ventana de gracia, no hay "deshacer" en los primeros N minutos.
>
> Una captura equivocada se corrige creando su reversa, y **ambos registros quedan visibles** en el historial. Es deliberado: un historial que se puede borrar es un historial cuyos reportes no son reproducibles.
>
> Lo único editable de una transacción es su `description`, vía `PATCH`.

Errores: `409 ALREADY_REVERSED` (una transacción solo se revierte una vez), `409 CANNOT_REVERSE_REVERSAL` (para deshacer un deshacer, registra una transacción nueva), `404`.

### 11.9 `GET /transactions`

Cursor. Query: `from?`, `to?` (fechas inclusivas), `accountId?`, `categoryId?`, `limit?`, `cursor?`.

```json
{
  "data": [
    {
      "id": "9a8b...",
      "bookedAt": "2026-08-09",
      "description": "Cena con Fer",
      "totalCents": "80000",
      "reversesTransactionId": null,
      "reversedByTransactionId": null,
      "createdAt": "2026-08-09T21:14:02.331Z",
      "movements": [
        { "accountId": "a2b3...", "accountName": "TDC BBVA",    "accountKind": "credit",     "amountCents": "-80000" },
        { "accountId": "b1c2...", "accountName": "Comida",      "accountKind": "category",   "amountCents": "40000"  },
        { "accountId": "c4d5...", "accountName": "Fer me debe", "accountKind": "receivable", "amountCents": "40000"  }
      ]
    }
  ],
  "nextCursor": "eyJiIjoiMjAyNi0wOC0wOSIsInQiOiI5YThiLi4uIn0"
}
```

`movements` es **solo de lectura**. Ningún endpoint lo acepta como entrada. Cada `amountCents` es el efecto sobre esa cuenta, con signo — aplica la regla de §4.5 usando `accountKind`.

**Orden garantizado:** `amountCents` ascendente — primero de dónde salió el dinero (negativos), luego a dónde fue (positivos) — y estable entre lecturas. Si dos movimientos comparten el mismo monto (un split simétrico, como el ejemplo de arriba con los dos `40000`), el desempate no tiene significado de negocio, pero el orden entre ellos no cambia de una lectura a otra.

`reversedByTransactionId` no es nulo cuando esa transacción ya fue revertida. Úsalo para tacharla o marcarla en la UI.

### 11.10 `GET /transactions/{id}` · `PATCH /transactions/{id}`

`GET` devuelve la misma forma de arriba. `PATCH` acepta **solo** `description`:

```json
{ "description": "Wifi agosto — Totalplay" }
```

Cualquier otro campo da `400 VALIDATION_FAILED`.

### 11.11 Qué pasa con la fecha y el periodo

**El ledger nunca rechaza una transacción.** El saldo de la cuenta se corrige **siempre**, sin importar la fecha ni el estado del periodo. El usuario no elige a qué periodo pertenece un gasto: se deriva de `bookedAt`.

| `bookedAt` cae en… | Qué pasa | `budgetImpact.status` |
|---|---|---|
| Un periodo abierto | Se asigna solo, sin aviso | `in_open_period` |
| Un periodo **cerrado**, habiendo una quincena abierta que cubre hoy | La transacción se guarda con su fecha real, y el impacto presupuestal se aplica a la quincena actual — ver §11.12 | `compensated` |
| Un periodo **cerrado**, sin quincena abierta que cubra hoy | La transacción se guarda. No se ajusta ningún presupuesto | `uncompensated` |
| Un hueco entre periodos, o antes del primero | La transacción se guarda y aparece en `GET /insights/unbudgeted-transactions` | `no_period` |

**Los huecos entre periodos están permitidos.** Un usuario puede tener `1–15 ago` y `20–31 ago`. Las transacciones del hueco simplemente no pertenecen a ningún periodo y salen en la lista de pendientes por asignar para que el usuario decida.

### 11.12 Captura tardía — qué hace la API y qué tiene que explicar la UI

Capturar un gasto días después de que ocurrió, con la quincena ya cerrada, es el flujo **normal** de una app de presupuesto personal. La API lo resuelve así:

- **La transacción se guarda con su fecha real.** El historial nunca miente sobre cuándo ocurrió el gasto, y el saldo de la cuenta se corrige siempre.
- **El impacto presupuestal se aplica a la quincena abierta actual**, restando del sobre correspondiente. Es lo correcto: el dinero salió y hay que cubrirlo con lo que hay hoy.
- **La quincena cerrada conserva su sobregiro histórico**, intocado. Si consultas `GET /insights/category-balances?periodId=<la cerrada>`, el gasto aparece ahí.

**Ejemplo.** Hoy es 20 de agosto. La quincena 1–15 está cerrada, la 16–31 abierta. Capturas $500 de Comida con fecha 12 de agosto:

- `Comida` en la quincena **1–15** muestra $500 más de gastado. Es historia; no se puede tocar.
- `Comida` en la quincena **16–31** baja $500 de asignado. Ahí es donde el usuario cubre el hueco.
- El dinero por asignar **no cambia mientras el sobre alcance a absorber el ajuste**: el gasto se cargó al sobre, no al pozo general. Si Comida tenía menos de $500 asignados, su disponible queda en negativo y ese déficit **sí** resta del dinero por asignar — exactamente igual que cualquier sobregiro (§14).

**Qué tiene que hacer la UI:**

1. **Avisar antes de guardar** cuando la fecha capturada cae en una quincena cerrada. No después.
2. Al recibir `status: "compensated"`, mostrar el ajuste explícitamente: *"Este gasto se descontó de Comida en la quincena actual."* Sin ese mensaje, el usuario ve bajar su disponible sin causa aparente.
3. Al recibir `status: "uncompensated"`, avisar que el gasto afectó el saldo pero ninguna quincena, y ofrecer crear la quincena actual.

**El ajuste aparece como una asignación normal.** En `GET /periods/{id}/allocations` sale con `source: "manual"` y una `note` que referencia la transacción de origen. Se puede borrar como cualquier otra asignación — la API no lo protege. Ver §15.1b.

**Un sobre que solo recibió un ajuste queda con `assignedCents` negativo, `hasBudget: true` y `status: "overspent"`, aunque su `spentCents` sea `"0"`** en esa quincena. Es correcto y hay que explicarlo: lo gastado está en la quincena anterior, lo que hay que cubrir está en esta.

> ### ⚠️ No mandes `bookedAt` al revertir una captura tardía — la API lo rechaza
>
> La reversa genera el ajuste inverso automáticamente cuando hereda la fecha del original, que es el default al omitir el campo.
>
> **Si la transacción que estás revirtiendo generó un ajuste** — es decir, si su `bookedAt` caía en una quincena cerrada — mandar `bookedAt` en el body devuelve `422 REVERSAL_DATE_LOCKED` y no escribe nada.
>
> No es una recomendación, está bloqueado en el servidor: una reversa con fecha distinta dejaría el ajuste original huérfano, y el sobre de la quincena actual seguiría descontado por un gasto ya revertido, sin nada que lo señale.
>
> **Omite `bookedAt` en las reversas.** Si la transacción original no fue una captura tardía, el campo sigue siendo sobreescribible con normalidad.

---

## 12. Budget — periodos y asignaciones

### 12.1 Periods

```json
{
  "id": "d3e4...",
  "startsOn": "2026-08-01",
  "endsOn": "2026-08-15",
  "status": "open",
  "closedAt": null,
  "createdAt": "...", "updatedAt": "..."
}
```

`status ∈ { open, closed }`. `endsOn` es **inclusivo**.

**Las fechas son datos, no una regla.** No se derivan de un "día de corte": el usuario define cada rango. Eso permite quincenas fijas (1–15) y variables (2–16) sin ningún cambio.

#### `GET /periods`

Query: `status?`, `page?`, `pageSize?`. Offset. Orden: más reciente primero.

#### `GET /periods/current`

El periodo que cubre **hoy** en la zona horaria del usuario. `404 NO_CURRENT_PERIOD` si hoy cae en un hueco o antes del primer periodo.

**No hay creación automática de periodos.** Cuando esto devuelve `404`, la app debe proponer crear uno. Siempre es una acción explícita del usuario.

#### `POST /periods`

```json
{ "startsOn": "2026-08-16", "endsOn": "2026-08-31" }
```

Errores: `409 PERIOD_OVERLAP` (los periodos no se pueden traslapar), `422 INVALID_INPUT` (`endsOn` anterior a `startsOn`).

#### `PATCH /periods/{id}`

Acepta `startsOn` y `endsOn`. **Solo mientras el periodo está abierto** → si está cerrado, `409 PERIOD_CLOSED`. Un periodo cerrado ya determinó qué transacciones le pertenecen y ya arrastró su sobrante; mover sus fechas después dejaría ese arrastre sin correspondencia.

#### `DELETE /periods/{id}`

`204`. Es un borrado suave: el periodo desaparece de los listados y deja de contar en todos los cálculos.

**Precondiciones:**

| Bloqueo | `code` |
|---|---|
| El periodo está cerrado | `409 PERIOD_CLOSED` |
| Tiene asignaciones vigentes, de cualquier origen | `409 PERIOD_NOT_EMPTY` |

**No bloquea por transacciones.** Borrar un periodo que contenía gastos hace que esos gastos aparezcan en `unbudgeted-transactions`. Es un estado válido y se revierte creando un periodo que los cubra. **Avisa al usuario antes de borrar** si el rango contiene transacciones.

Después de borrar, se puede crear un periodo nuevo con el mismo rango.

### 12.2 Allocations — asignar presupuesto

Una asignación es un movimiento de presupuesto hacia un sobre, dentro de un periodo. **No mueve dinero real**, solo lo destina.

```json
{
  "id": "1a2b...",
  "periodId": "d3e4...",
  "categoryId": "b1c2...",
  "categoryName": "Comida",
  "amountCents": "200000",
  "source": "manual",
  "note": null,
  "createdAt": "..."
}
```

`source ∈ { manual, rollover }`. `manual` la creó el usuario; `rollover` la generó el cierre del periodo anterior.

**Las asignaciones se acumulan.** Asignar `+200000` y luego `-50000` deja el sobre en `150000` asignado, con dos registros. Por eso `hasBudget` se deriva del conteo y no del monto.

#### `GET /periods/{id}/allocations`

Todas las asignaciones vigentes del periodo. Sin paginar: la lista es corta por construcción.

#### `POST /periods/{id}/allocations` — asignar un delta

```json
{ "categoryId": "b1c2...", "amountCents": "200000", "note": null }
```

`amountCents` puede ser negativo (desasignar). **No puede ser `"0"`.**

#### `PUT /periods/{id}/allocations/{categoryId}` — fijar el asignado

```json
{ "targetAssignedCents": "500000" }
```

**Este es el endpoint que debe usar la UI de sobres.** El usuario escribe "quiero 5000 en Comida"; el servidor calcula la diferencia contra lo que ya hay y escribe solo el delta, **de forma atómica**.

Es idempotente y seguro ante dos pestañas abiertas: dos clientes que fijen `500000` al mismo tiempo dejan el sobre en `500000`, no en `700000`. Si no hay diferencia que escribir, responde `200` sin crear nada.

Respuesta: el estado resultante del sobre en ese periodo.

```json
{
  "periodId": "d3e4...",
  "categoryId": "b1c2...",
  "assignedCents": "500000",
  "spentCents": "50000",
  "availableCents": "450000",
  "hasBudget": true,
  "status": "available"
}
```

#### `POST /periods/{id}/allocations/move` — mover entre sobres

```json
{ "fromCategoryId": "b1c2...", "toCategoryId": "f5a6...", "amountCents": "30000" }
```

`amountCents` estrictamente positivo. Es la operación para cubrir un sobregiro: quitar de un sobre con sobrante y ponerlo en el que está en negativo. Se escribe como una sola operación atómica.

Errores: `422 SAME_CATEGORY_MOVE`, `409 PERIOD_CLOSED`.

#### `DELETE /periods/{id}/allocations/{allocationId}`

`204`. Borrado suave.

**Todas las escrituras de asignación fallan con `409 PERIOD_CLOSED` si el periodo está cerrado**, incluido el borrado. Un periodo cerrado ya propagó su sobrante; modificar sus asignaciones después dejaría el monto arrastrado sin correspondencia.

### 12.3 Cerrar un periodo

**El cierre es manual y explícito.** No hay job automático. Cuando existe un periodo con `endsOn` ya pasado y `status: "open"`, la app debe avisar, mostrar el resumen, y pedir confirmación.

#### `GET /periods/{id}/close-preview`

**No escribe nada.** Devuelve exactamente lo que va a pasar al cerrar.

```json
{
  "periodId": "d3e4...",
  "startsOn": "2026-08-01",
  "endsOn": "2026-08-15",
  "nextPeriodId": "aa77...",
  "canClose": true,
  "blockers": [],
  "categories": [
    {
      "categoryId": "cc11...", "categoryName": "Servicios", "rolloverType": "accumulate",
      "assignedCents": "200000", "spentCents": "50000", "availableCents": "150000",
      "hasBudget": true, "action": "carry_forward", "carryCents": "150000"
    },
    {
      "categoryId": "b1c2...", "categoryName": "Comida", "rolloverType": "reset",
      "assignedCents": "200000", "spentCents": "150000", "availableCents": "50000",
      "hasBudget": true, "action": "release", "carryCents": "0"
    },
    {
      "categoryId": "f5a6...", "categoryName": "Salud", "rolloverType": "accumulate",
      "assignedCents": "0", "spentCents": "30000", "availableCents": "-30000",
      "hasBudget": false, "action": "carry_deficit", "carryCents": "-30000"
    }
  ]
}
```

| `action` | Qué pasa al cerrar |
|---|---|
| `carry_forward` | Sobró y el sobre es `accumulate` → el sobrante se arrastra al periodo siguiente |
| `release` | Sobró y el sobre es `reset` → el sobrante se libera y vuelve al dinero por asignar |
| `carry_deficit` | Está en sobregiro → **el déficit se arrastra siempre**, sin importar el `rolloverType` |
| `none` | Ni sobrante ni déficit; no pasa nada |

Cuando `canClose` es `false`, `blockers` trae los mismos códigos que devolvería el `POST`. Úsalo para deshabilitar el botón con un mensaje concreto en vez de dejar que el usuario lo apriete y falle.

#### `POST /periods/{id}/close`

Sin body. Todo ocurre atómicamente.

```json
{
  "period": {
    "id": "d3e4...", "startsOn": "2026-08-01", "endsOn": "2026-08-15",
    "status": "closed", "closedAt": "2026-08-16T14:02:11.884Z",
    "createdAt": "...", "updatedAt": "..."
  },
  "nextPeriodId": "aa77...",
  "carriedForward":  [ { "categoryId": "cc11...", "categoryName": "Servicios", "amountCents": "150000"  } ],
  "carriedDeficits": [ { "categoryId": "f5a6...", "categoryName": "Salud",     "amountCents": "-30000"  } ],
  "released":        [ { "categoryId": "b1c2...", "categoryName": "Comida",    "amountCents": "50000"   } ]
}
```

**Precondiciones — todas devuelven `409` y no escriben nada:**

| `code` | Significa | Qué hacer |
|---|---|---|
| `PERIOD_ALREADY_CLOSED` | Ya estaba cerrado | Refrescar |
| `EARLIER_PERIOD_OPEN` | Hay un periodo anterior sin cerrar | **Cerrar en orden cronológico.** La UI debe presentar los cierres pendientes ordenados y no ofrecer cerrar uno si hay otro anterior abierto |
| `NEXT_PERIOD_REQUIRED` | No existe un periodo posterior contra el cual arrastrar | Crear el periodo siguiente y reintentar |
| `NEXT_PERIOD_CLOSED` | El periodo siguiente ya está cerrado | Sin remedio en v1 — ver §15 |

**"El periodo siguiente"** es el que empieza en la fecha más cercana posterior al `endsOn` del que se cierra. Con huecos permitidos, sigue siendo determinista.

> ### ⚠️ Un periodo vencido sin cerrar retiene su dinero
>
> Mientras un periodo no se cierre, todo su dinero asignado sigue contando como comprometido y **no aparece como disponible para asignar**. El usuario ve menos dinero del que realmente puede repartir.
>
> Es el comportamiento correcto — el cierre es lo que decide si el sobrante se arrastra o se libera — pero significa que la app **debe insistir activamente** en cerrar periodos vencidos. Un banner al abrir la app cuando existe un periodo con `endsOn` pasado y `status: "open"` no es opcional.

---

## 13. Recurring templates

**Son solo recordatorios.** Nunca generan una transacción por su cuenta. El usuario confirma y en ese momento se registra el gasto real.

```json
{
  "id": "5f6a...",
  "name": "Wifi Totalplay",
  "categoryId": "cc11...", "categoryName": "Servicios",
  "accountId": "a2b3...",  "accountName": "TDC BBVA",
  "amountCents": "70000",
  "dayOfMonth": 15,
  "nextDueOn": "2026-08-15",
  "lastConfirmedOn": "2026-07-15",
  "isActive": true,
  "isDue": false,
  "createdAt": "...", "updatedAt": "..."
}
```

`amountCents` es un **estimado**, siempre positivo. `accountId` es la cuenta de pago **sugerida** y puede ser `null`. `isDue` es `true` cuando `nextDueOn` ya llegó o pasó, calculado en la zona del usuario.

### `GET /recurring-templates`

Query: `dueOnly?`, `includeInactive?`, `page?`, `pageSize?`.

### `POST /recurring-templates`

```json
{
  "name": "Wifi Totalplay",
  "categoryId": "cc11...",
  "accountId": "a2b3...",
  "amountCents": "70000",
  "dayOfMonth": 15
}
```

`dayOfMonth` entre 1 y 31. `nextDueOn` es opcional; si no lo mandas, el servidor lo calcula.

### `PATCH /recurring-templates/{id}` · `DELETE /recurring-templates/{id}`

`PATCH` acepta `name`, `categoryId`, `accountId`, `amountCents`, `dayOfMonth`, `isActive`. `DELETE` responde `204` (borrado suave).

### `POST /recurring-templates/{id}/confirm`

**Requiere `Idempotency-Key`.** Todos los campos del body son opcionales y sobreescriben los de la plantilla:

```json
{
  "bookedAt": "2026-08-15",
  "amountCents": "72500",
  "paidFromAccountId": "8f1c...",
  "description": "Wifi Totalplay — agosto"
}
```

Defaults: `bookedAt` = hoy en la zona del usuario · `amountCents` = el de la plantilla · `paidFromAccountId` = el `accountId` de la plantilla · `description` = el `name` de la plantilla.

Respuesta `201` (o `200` por idempotencia):

```json
{
  "transaction": {
    "id": "9a8b...", "bookedAt": "2026-08-15", "description": "Wifi Totalplay — agosto",
    "totalCents": "72500", "reversesTransactionId": null, "createdAt": "..."
  },
  "template": {
    "id": "5f6a...", "name": "Wifi Totalplay", "amountCents": "70000", "dayOfMonth": 15,
    "nextDueOn": "2026-09-15", "lastConfirmedOn": "2026-08-15", "isActive": true, "isDue": false,
    "categoryId": "cc11...", "categoryName": "Servicios",
    "accountId": "a2b3...",  "accountName": "TDC BBVA",
    "createdAt": "...", "updatedAt": "..."
  }
}
```

**El monto real no modifica el estimado de la plantilla.** Pagar $725 este mes no cambia el estimado de $700.

Si ni el body ni la plantilla tienen cuenta de pago → `422 PAYMENT_ACCOUNT_REQUIRED`.

**En una respuesta `200` por idempotencia, la plantilla no avanza dos veces.** Reintentar es seguro.

### Cómo avanza `nextDueOn`

El cálculo parte del `dayOfMonth` aplicado a un mes derivado de `lastConfirmedOn`:

| Condición | Mes objetivo |
|---|---|
| `día(lastConfirmedOn) < dayOfMonth` | El **mismo** mes de `lastConfirmedOn` |
| `día(lastConfirmedOn) >= dayOfMonth` | El mes **siguiente** |

**Si el día no existe en el mes objetivo, `nextDueOn` es el primer día del mes siguiente:**

| `dayOfMonth` | Mes objetivo | `nextDueOn` |
|---|---|---|
| 31 | Febrero (bisiesto o no) | 1 de marzo |
| 30 | Febrero | 1 de marzo |
| 31 | Abril | 1 de mayo |
| 31 | Mayo | 31 de mayo |

Desplazar hacia adelante evita que un recordatorio se dispare antes de que el cargo real pudiera haber ocurrido.

**No hay `/skip`.** Para saltar un ciclo, edita `nextDueOn` con `PATCH`.

---

## 14. Insights

Los cuatro números derivados de la app. **Toda la aritmética vive aquí**; ningún otro endpoint calcula saldos.

### `GET /insights/account-balances`

```json
{
  "accounts": [
    { "accountId": "8f1c...", "name": "Nu",          "kind": "cash",          "currency": "MXN", "balanceCents": "920000"  },
    { "accountId": "a2b3...", "name": "TDC BBVA",    "kind": "credit",        "currency": "MXN", "balanceCents": "-250000" },
    { "accountId": "c4d5...", "name": "Fer me debe", "kind": "receivable",    "currency": "MXN", "balanceCents": "50000"   },
    { "accountId": "b1c2...", "name": "Comida",      "kind": "category",      "currency": "MXN", "balanceCents": "125000"  },
    { "accountId": "e7f8...", "name": "Sueldo",      "kind": "income_source", "currency": "MXN", "balanceCents": "-1000000"}
  ]
}
```

**Incluye cuentas archivadas** — su dinero sigue siendo tuyo. Nunca incluye cuentas de sistema. Una cuenta sin movimientos aparece con `"0"`, no desaparece.

### `GET /insights/category-balances?periodId=...`

`periodId` es obligatorio.

```json
{
  "periodId": "d3e4...",
  "categories": [
    { "categoryId": "b1c2...", "name": "Comida", "assignedCents": "200000", "spentCents": "50000",
      "availableCents": "150000", "hasBudget": true,  "status": "available" },
    { "categoryId": "f5a6...", "name": "Salud",  "assignedCents": "0",      "spentCents": "30000",
      "availableCents": "-30000","hasBudget": false, "status": "no_budget" }
  ]
}
```

Mismo bloque que devuelve `GET /categories?periodId=`, sin los datos de la cuenta.

### `GET /insights/unassigned-funds`

**El número más importante de la app:** cuánto dinero real tienes sin destinar.

```json
{ "unassignedCents": "740000" }
```

Devuelve **siempre** exactamente un valor. Un usuario nuevo obtiene `"0"`.

**Cómo se calcula, para que la UI lo pueda explicar:**

```
sin asignar = dinero real − comprometido
```

- **Dinero real** = saldo de cuentas `cash` + saldo de cuentas `credit` (negativo, así que la deuda resta). Sin filtro de periodo: es el dinero que existe hoy. **`receivable` no cuenta** — no puedes presupuestar lo que no tienes en mano.
- **Comprometido** = por cada sobre en cada **periodo abierto**, tanto el sobrante apartado como el déficit por cubrir. Los periodos cerrados no cuentan: ya materializaron su resultado.

**Ejemplo:** $10,000 en efectivo. Asignas $2,000 a Comida y gastas $500. Gastas $300 en Salud sin presupuesto.

```
dinero real     = 10,000 − 500 − 300 = 9,200
Comida          = 2,000 − 500  = +1,500   (apartado)
Salud           = 0 − 300      =   −300   (por cubrir)
comprometido    = 1,500 + 300  =  1,800
sin asignar     = 9,200 − 1,800 = 7,400
```

Un sobregiro **resta** dinero disponible, no lo suma.

**Con dos periodos abiertos a la vez** — el caso típico de "ya me pagaron y no he cerrado el anterior" — el dinero apartado en **ambos** sigue comprometido. Por eso el número puede verse bajo justo cuando el usuario acaba de recibir dinero: le falta cerrar el periodo pasado.

### `GET /insights/unbudgeted-transactions`

Transacciones cuya fecha no cae dentro de ningún periodo. Sin paginar.

```json
{
  "transactions": [
    { "transactionId": "9a8b...", "bookedAt": "2026-08-18", "description": "Café" }
  ]
}
```

Una transacción dentro de un periodo **cerrado** sí tiene periodo, así que **no** aparece aquí.

### `GET /insights/dashboard`

Query: `periodId?`. Sin él, resuelve el periodo que cubre hoy.

Una sola llamada con todo lo que necesita la pantalla principal:

```json
{
  "accounts": [ /* igual que /insights/account-balances */ ],
  "unassignedCents": "740000",
  "period": { "id": "d3e4...", "startsOn": "2026-08-01", "endsOn": "2026-08-15", "status": "open", "closedAt": null },
  "categories": [ /* igual que /insights/category-balances */ ],
  "unbudgetedTransactions": [ /* igual que /insights/unbudgeted-transactions */ ]
}
```

`period` y `categories` vienen en `null` y `[]` si no hay periodo actual ni `periodId`. Los valores son idénticos a los de los endpoints individuales.

---

## 15. Limitaciones conocidas de v1

Cosas que la API **no** puede hacer todavía. Diséñalas en la UI sabiendo esto.

### 15.1 Un periodo cerrado no se puede reabrir ni editar

**No existe** `POST /periods/{id}/reopen`. Un periodo cerrado queda congelado: no admite cambio de fechas, ni asignaciones nuevas, ni edición o borrado de las existentes.

**Esto ya no bloquea la captura tardía** — ese caso se resuelve con la compensación al periodo actual (§11.12). Lo que sigue sin poder hacerse es **corregir el presupuesto histórico** de una quincena ya cerrada. Si el usuario asignó mal y ya cerró, ese número queda como quedó.

**Qué hacer en la UI:** poner el peso en el `close-preview`. Es el último momento en que las asignaciones de esa quincena son editables, y hay que dejarlo claro antes de confirmar.

### 15.1b Los ajustes de captura tardía se pueden borrar

El ajuste que genera una captura tardía es una asignación `manual` ordinaria: la API no la vincula con la transacción que la originó, así que el usuario puede borrarla con `DELETE /periods/{id}/allocations/{allocationId}` y nada lo impide. El gasto queda sin cubrir en la quincena actual, sin aviso.

**Qué hacer en la UI:** identificar estos ajustes por el formato fijo de su `note` y pedir confirmación explícita antes de borrarlos, distinta de la de una asignación normal.

El otro riesgo de esta familia — que una reversa con fecha sobreescrita deje el ajuste huérfano — **ya no existe**: la API lo bloquea con `422 REVERSAL_DATE_LOCKED` (§11.8 y §11.12).

### 15.2 Los cierres tienen que hacerse en orden

Si el usuario cierra la quincena 2 antes que la 1, la 1 **ya no se puede cerrar nunca** (`EARLIER_PERIOD_OPEN` lo impide antes, y sin reapertura no hay salida).

Por eso la API rechaza el cierre desordenado. **La UI debe reforzarlo:** presentar los cierres pendientes en orden cronológico y no ofrecer cerrar uno si hay otro anterior abierto.

### 15.3 No hay marca de onboarding

No existe un campo `onboardingCompleted`. La señal es **cero cuentas de `kind: "cash"`** en `GET /accounts`. Un usuario nuevo tiene sobres y una fuente de ingreso, pero ninguna cuenta donde poner dinero.

### 15.4 No hay conversión de moneda

Multi-moneda existe a nivel de cuenta, no de transacción. Una transacción que mezcle monedas falla. No hay tipo de cambio, no hay totales consolidados entre monedas.

### 15.5 No hay categoría de "Pérdidas" predefinida

`POST /transactions/loan-write-offs` exige un `categoryId` que tú eliges. Si quieres ofrecer una por default, créala con `POST /categories` como cualquier otra.

### 15.6 No hay `/skip` en recurrentes

Para saltar un ciclo, edita `nextDueOn` con `PATCH /recurring-templates/{id}`.

### 15.7 No hay rate limiting, ni webhooks, ni tiempo real

No hay push, no hay suscripciones, no hay polling recomendado. Refresca cuando el usuario actúe.

---

## 16. Flujos completos

### 16.1 Onboarding

```
1. GET  /me                              → timezone del usuario
2. GET  /accounts                        → si data está vacío, arrancar el flujo de alta
3. POST /accounts        × N             → crear las cuentas reales (cash, credit, receivable)
4. POST /transactions/opening-balances   → capturar el saldo de cada una (Idempotency-Key)
5. GET  /categories                      → viene VACÍO en un usuario nuevo: presentar la lista
                                           sugerida de §10.3 con checkboxes preseleccionados
6. POST /categories      × N             → crear los sobres que el usuario eligió, con su rolloverType
7. POST /income-sources  × N             → crear "Sueldo" si lo eligió, u otras fuentes
8. POST /periods                         → primera quincena
9. PUT  /periods/{id}/allocations/{cat}  × N   → repartir el dinero
10. GET /insights/dashboard              → estado inicial
```

### 16.2 Registrar un gasto

```
1. Generar un UUID v4 y guardarlo en el estado del formulario
2. Si la fecha capturada cae en una quincena cerrada, avisar ANTES de mandar
3. POST /transactions/expenses   con Idempotency-Key: <ese uuid>
   → 201: creado
   → 200: ya existía (reintento). Tratar igual que 201
   → 409 IDEMPOTENCY_IN_FLIGHT: esperar 1s y reintentar con la MISMA llave
   → 409 PERIOD_CLOSED: carrera rara — reintentar con la MISMA llave
4. Leer budgetImpact.status:
   compensated   → mostrar qué sobre se ajustó y por cuánto
   uncompensated → avisar y ofrecer crear la quincena actual
   no_period     → avisar que quedará en "pendientes de asignar"
5. GET /insights/dashboard  →  refrescar saldos y disponibles
```

### 16.3 Cerrar la quincena

```
1. GET /periods?status=open              → ¿hay alguno con endsOn ya pasado?
2. Ordenar cronológicamente y tomar el más antiguo
3. GET /periods/{id}/close-preview       → mostrar el resumen; si canClose=false, mostrar blockers
4. Si falta el periodo siguiente:  POST /periods
5. POST /periods/{id}/close              → confirmar
6. GET /periods/{next}/allocations       → los rollovers ya están ahí, con source: "rollover"
7. GET /insights/unassigned-funds        → el dinero liberado ya aparece disponible
```

### 16.4 Cubrir un sobregiro

```
1. GET /categories?periodId=...          → filtrar status === "overspent"
2. De la misma respuesta, filtrar availableCents > 0 y ordenar descendente
3. Ofrecer esos sobres como origen
4. POST /periods/{id}/allocations/move   → { fromCategoryId, toCategoryId, amountCents }
```

### 16.5 Corregir una captura equivocada

```
1. POST /transactions/{id}/reversal   con Idempotency-Key, SIN mandar bookedAt
2. POST /transactions/expenses        con la captura correcta y OTRA Idempotency-Key
3. Ambas transacciones quedan visibles en el historial. Marcar la original con
   reversedByTransactionId no nulo (tachada, con etiqueta "corregida")
```

**Omitir `bookedAt` en el paso 1 no es opcional** si la transacción original fue una captura tardía: es lo que hace que el ajuste presupuestal se neutralice solo (§11.12).

---

## 17. Mapeo sugerido a la interfaz en español

**La API no habla español.** Este mapeo es responsabilidad del frontend y vive en una sola capa de traducción, no regado por los componentes.

| API | Interfaz |
|---|---|
| `account` (`kind: cash`) | Cuenta |
| `account` (`kind: credit`) | Tarjeta |
| `account` (`kind: receivable`) | Te deben |
| `category` | **Sobre** |
| `income_source` | Fuente de ingreso |
| `period` | **Quincena** (o "Periodo" si el usuario define rangos no quincenales) |
| `allocation` | Asignación |
| `assignedCents` | Asignado |
| `spentCents` | Gastado |
| `availableCents` | **Disponible** |
| `unassignedCents` | **Por asignar** |
| `balanceCents` | Saldo |
| `rolloverType: accumulate` | Acumula |
| `rolloverType: reset` | Reinicia |
| `status: no_budget` | Sin presupuesto |
| `status: available` | Disponible |
| `status: depleted` | Agotado |
| `status: overspent` | **Sobregiro** |
| `transfer` | Transferencia / Pago de tarjeta |
| `loan` | Préstamo |
| `loan-repayment` | Cobro |
| `loan-write-off` | Dar por perdido |
| `reversal` | Corrección |
| `recurring template` | Recordatorio |
| `budgetImpact` | Impacto en el presupuesto |
| `compensated` | Ajustado en la quincena actual |
| `uncompensated` | Sin quincena donde ajustar |

**Nunca muestres al usuario:** `movement`, `entry`, `ledger`, `system`, ni el signo crudo de un monto sin aplicar la regla de §4.5.

---

## 18. Checklist para el frontend

- [ ] Todos los montos se manejan en centavos como string. `formatMoney(cents)` existe una sola vez y se llama solo al pintar.
- [ ] El signo se transforma según `kind`, nunca por nombre de cuenta ni por pantalla.
- [ ] `bookedAt` se resuelve en la zona del usuario **antes** de mandarlo, como `YYYY-MM-DD`.
- [ ] El `Idempotency-Key` se genera **una vez por intención**, se guarda en el estado del formulario y se reusa en cada reintento.
- [ ] `IDEMPOTENCY_IN_FLIGHT` se maneja como reintento automático a 1s, no como error visible.
- [ ] El manejo de errores es por `code`, nunca por `message`.
- [ ] El `401` no pierde el contenido del formulario.
- [ ] `no_budget` se pinta distinto de `depleted`. No son lo mismo.
- [ ] Hay un aviso persistente cuando existe un periodo vencido sin cerrar.
- [ ] Los cierres pendientes se presentan en orden cronológico, y no se ofrece cerrar uno si hay otro anterior abierto.
- [ ] Se avisa **antes de guardar** una transacción con fecha dentro de un periodo cerrado.
- [ ] `budgetImpact.status` se lee en cada creación, y `compensated` / `uncompensated` producen un mensaje visible al usuario (§11.12).
- [ ] Las reversas se mandan **sin** `bookedAt`. Si el original fue una captura tardía, mandarlo devuelve `422 REVERSAL_DATE_LOCKED`.
- [ ] Borrar un ajuste de captura tardía (asignación `manual` con `note` de referencia) pide confirmación distinta de la de una asignación normal.
- [ ] Un sobre con `assignedCents` negativo y `spentCents` en `"0"` se explica, no se pinta como un error.
- [ ] El `close-preview` deja claro que es el último momento para editar las asignaciones de esa quincena.
- [ ] Se avisa antes de borrar un periodo cuyo rango contiene transacciones.
- [ ] Los cursores se tratan como opacos y no se persisten entre sesiones.
- [ ] La UI de sobres usa `PUT .../allocations/{categoryId}`, no el `POST` de delta.
- [ ] Existe una sola capa de traducción API → español (§17).
