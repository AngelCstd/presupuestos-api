# PROGRESS.md

## ⚠️ Si `docker ps -a` sale vacío al arrancar una sesión

Ya pasó dos veces (2026-08-09, sesiones de TASK-auth y TASK-api): el
contenedor `db-test` desaparece por completo entre sesiones — no es un
crash (`restart: unless-stopped` en `docker-compose.yml` no cubre esto,
solo cubre que el proceso muera con el contenedor vivo), es que el
contenedor y hasta la red se recrean desde cero. Recuperación, en este
orden exacto:

```bash
docker compose up -d db-test
# esperar a que healthcheck reporte "healthy" (docker inspect --format='{{.State.Health.Status}}' presupuestos-db-test-1)
npx dotenv -e .env -- npx tsx -e "import { applyAuthStub } from './test/setup/apply-auth-stub'; applyAuthStub().then(() => console.log('stub aplicado'))"
npx dotenv -e .env -- npx prisma migrate deploy
```

Si `migrate deploy` truena con `P3018` en la primera migración que
referencia `auth.users`, es que el stub se aplicó después de un intento
previo fallido — resolver con
`npx dotenv -e .env -- npx prisma migrate resolve --rolled-back <nombre_de_la_migración>`
y reintentar `migrate deploy`.

## 2026-08-17 — Bug de producción: `dashboard` sin periodId y sin periodo actual daba 404 en vez de 200

**Por qué:** encontrado probando el frontend contra la API local con una
base recién vaciada — `GET /insights/dashboard` sin `periodId` y sin
ningún periodo que cubra hoy devolvía `404 PERIOD_NOT_FOUND`. Es el
estado de **cualquier usuario nuevo** (perfil creado, cero periodos) y
es la primera llamada de la pantalla principal — la app arrancaba rota.

**Causa:** `InsightsService.dashboard()` llamaba incondicionalmente a una
función que lanzaba `PeriodNotFoundException` si ningún periodo cubría
hoy, sin importar si venía `periodId` o no. Contradice `API-CONTRACT.md`
§14 línea 1340, explícito: *"`period` y `categories` vienen en `null` y
`[]` si no hay periodo actual ni `periodId`"*.

**Origen — decisión propia, sin cruzar el contrato.** Al implementar A10
(loop de A07-A11), interpreté de más la fila `404 PERIOD_NOT_FOUND` de
`TASK-api.md` §6.10: ese error es correcto para `periodId` explícito e
inválido (igual que `category-balances`), pero lo apliqué también al
caso "sin `periodId`, sin periodo actual" — que el contrato ya resolvía
distinto — sin revisar `API-CONTRACT.md` en su momento.

**El test que faltaba, diagnosticado antes de tocar nada:**
`seedUser()` (`test/setup/fixture.ts`) siembra **siempre** dos periodos
por usuario — no hay ninguna ruta de fixture que produzca un usuario sin
periodos. T-O13 (el test más cercano) borra los periodos del fixture
pero inmediatamente crea uno nuevo que cubre hoy; nunca llega a ejercer
cero periodos. Nadie escribió el caso porque nadie se topó con él sin
construirlo a mano.

**Ciclo normal — test primero:** `T-O16` nuevo en
`insights.integration.spec.ts` — mismo patrón que T-O13 (borra los
periodos del fixture) pero **sin** crear uno de reemplazo; confirma
`200` con `period: null`, `categories: []`, y que el resto del payload
(`accounts`, `unassignedCents`, `unbudgetedTransactions`) sigue
calculado, no vacío por accidente. Corrido en rojo primero (`404`
recibido) para confirmar que ejercía el bug real.

**Implementación:** `DashboardResponseDto.period` pasa a `| null`.
`InsightsService.dashboard()`: con `periodId` explícito, sin cambios
(404 si no resuelve); sin `periodId`, resuelve el periodo actual **sin
lanzar** — si no hay, compone el resto del dashboard igual y devuelve
`period: null, categories: []`. Cero aritmética agregada (T-O14 lo
sigue verificando).

**Aclaración agregada a `TASK-api.md` §6.10** para que la misma
confusión no se repita: la fila de la tabla de errores ahora dice
explícitamente que el `404` es solo para `periodId` inválido, con una
nota aparte marcando que "sin periodId + sin periodo actual" es `200`,
no error — y apunta a este bug como la razón.

**Verificación real, no solo tests:** servidor levantado (`node
dist/main.js`) contra Postgres local con un JWKS propio, usuario nuevo
nunca sembrado con periodos → `GET /insights/dashboard` sin `periodId`
→ `200`, `{"accounts":[],"unassignedCents":"0","period":null,"categories":[],"unbudgetedTransactions":[]}`
— el caso exacto que reportó Luis.

Los cinco: `:auth` 22/22, `:core` 74/74, `:domain` 184/184 (183 + T-O16),
`:unit` 66/66, `:db` 124/124, `tsc --noEmit` limpio.

## 2026-08-15 (2) — El seed automático se reduce a la cuenta de sistema: P-07 resuelto, migración 08, las cinco en verde

**Por qué:** smoke test contra Supabase real — `GET /categories` vacío para
un usuario nuevo. Diagnóstico: **nada en `src/` invocaba `fn_seed_new_user`**.
`EnsureProfileExistsService.ensure()` solo hacía el upsert de `profiles`.
No es un bug nuevo: es **P-07 de `TASK-db.md`** ("Garantía de creación de
`profiles` + punto de invocación de los seeds"), documentado como
pendiente desde `TASK-db` y nunca cerrado del todo — la mitad
("garantía de creación") se resolvió con `EnsureProfileExistsService`
(TASK-auth), la otra mitad ("punto de invocación de los seeds") quedó
sin implementar.

**Consecuencia real, confirmada antes de tocar nada:**
`TransactionsService.createOpeningBalance()` hace
`equityAccount!.id` — con `findSystemEquity` devolviendo `null` (nunca
sembrada para un usuario real), esto truena con un `TypeError` sin
capturar. **`POST /transactions/opening-balances` estaba roto en
producción para cualquier usuario real**, sin que ningún test lo
detectara: `test/setup/fixture.ts` inserta las 12 cuentas de cada
usuario de prueba directo por SQL (`insertAccount`), sin pasar nunca por
`fn_seed_new_user` ni por `EnsureProfileExistsService` — el comentario
del propio fixture ya lo decía ("aún no existe: se insertan directo"),
solo que nadie volvió a revisarlo después de que la función sí llegó a
existir.

### Decisión de fondo (Luis)

El seed automático se reduce a la **cuenta de sistema** (`equity`,
`is_system=true`) — es infraestructura: sin ella `POST
/transactions/opening-balances` no funciona, y el usuario no puede
crearla por su cuenta (`equity` no es un `kind` direccionable; un
`accountId` con `is_system=true` da `403`). **Las 7 categorías y "Sueldo"
dejan de sembrarse** — son opinión, no infraestructura, y pasan a ser una
lista sugerida que presenta el frontend en el onboarding (checkboxes
preseleccionados), creada con los endpoints normales (`POST
/categories`, `POST /income-sources`). Sin endpoints nuevos.

### Implementación

- **Migración `20260815120000_08_seed_equity_only`** — `CREATE OR
  REPLACE FUNCTION fn_seed_new_user` (conserva nombre/firma de la
  migración 07, nunca editada). Reduce el `INSERT` a una sola fila
  (Saldo Inicial). Aplicada con `migrate deploy`, nunca `migrate
  dev`/`db push`.
- **`EnsureProfileExistsService.ensure()`** — ahora corre dentro de
  `prisma.$transaction(async (tx) => ...)`. El `INSERT ... ON CONFLICT
  DO UPDATE ... RETURNING` agrega `(xmax = 0) AS inserted` — idioma
  estándar de Postgres para distinguir, en el mismo `RETURNING`, si la
  fila vino de la rama INSERT (`xmax = 0`) o de la rama UPDATE del
  upsert (`xmax ≠ 0`). Solo si `inserted` es `true` se llama `SELECT
  fn_seed_new_user($1)`, dentro de la misma transacción. **Decisión de
  atomicidad, documentada en el código:** perfil y seed van juntos
  porque un perfil sin cuenta de sistema es un estado roto — separarlos
  abriría una ventana donde eso pasa. La concurrencia (T-7 de
  TASK-auth) se resuelve gratis: Postgres serializa el conflicto de la
  llave única de `profiles`, así que de dos `ensure()` en paralelo para
  el mismo usuario nuevo, solo una ve `inserted=true` y solo esa
  siembra — verificado con un test dedicado (T-7b).

### Dos hallazgos más, ninguno relacionado con el seed — ambos reportados antes de tocarlos

- **`PrismaAccountRepository.findMany` sin desempate real.**
  `accounts.created_at` usa `now()` de Postgres, que es **por
  transacción**, no por statement — las 12 cuentas de un usuario de
  fixture (insertadas en una sola transacción) comparten el mismo
  `created_at`. `orderBy: { createdAt: 'asc' }` dejaba el orden entre
  ellas indefinido; el churn de esta sesión contra el mismo Postgres
  local lo hizo visible (`accounts.list.json` cambió de orden sin que
  nadie tocara nada relacionado). Luis decidió (mismo razonamiento que
  el orden de `movements`, sesión anterior): **`name` ascendente, `id`
  de desempate, es el orden garantizado de `GET /accounts`, `GET
  /categories` y `GET /income-sources`** — documentado en
  `TASK-api.md` §6.5/§6.6/§6.10 (`insights.account-balances`/`dashboard`
  heredan el mismo orden, comparten repository). Se recapturaron 4
  fixtures: `accounts.list.json`, `categories.list-with-period.json`,
  `insights.account-balances.json`, `insights.dashboard.json`.
- **`T-R10` (contract-static) con un conteo de migraciones fijado a 25.**
  Guardrail de "cero migraciones nuevas" del loop de A07–A11, ya
  cerrado — la migración 08 es nueva y está autorizada, así que el
  número sube a 26. Actualizado el comentario para dejar claro que el
  guardrail sigue vivo (cualquier migración *no* autorizada lo sigue
  atajando), solo que el conteo base cambió.

### Tests

- `test/integration/k-seeds.spec.ts` — T-K01 reescrito (1 sola cuenta,
  equity). **T-K01b nuevo: afirma explícitamente que NO se siembran
  categorías ni "Sueldo"** — no solo por omisión. T-K02 sin cambios
  (0 asset/liability/receivable). T-K03 actualizado (conteo 1, no 9).
- `test/integration/auth/profile-creation.integration.spec.ts` — tres
  tests nuevos a nivel de servicio (no de función SQL): **T-4b**
  (usuario nuevo → se siembra la cuenta de sistema, nada más), **T-5b**
  (perfil ya existente → `ensure()` NO vuelve a sembrar), **T-7b**
  (concurrencia — dos `ensure()` en paralelo para el mismo usuario nuevo
  dejan UNA sola cuenta de sistema, no cero ni dos).
- Revisado qué más asumía las 7 categorías sembradas: **nada más** —
  `test/setup/fixture.ts` inserta todo directo por SQL, ajeno a
  `fn_seed_new_user` desde siempre; ningún test de `:core`/`:domain`/`:auth`
  pasa por el flujo real de creación de perfil para un usuario nuevo
  sin sembrar a mano.

### Verificación end-to-end real (no solo tests)

Servidor real (`node dist/main.js`) contra el Postgres local, con un
JWKS local propio (servidor HTTP + llave EC generada al vuelo, mismo
patrón que `mock-jwks-server.ts`) apuntado vía `SUPABASE_URL` — sin
tocar Supabase real. Usuario nuevo, nunca sembrado a mano:

```
GET  /me                              → 200, perfil creado
GET  /accounts                        → 200, [] (la cuenta de sistema NUNCA aparece aquí)
GET  /categories                      → 200, [] (ya no hay auto-seed)
POST /accounts (cash)                 → 201
POST /transactions/opening-balances   → 201  ← antes de este fix, TypeError sin capturar
GET  /accounts                        → balanceCents refleja el saldo inicial correctamente
```

Confirmado también que `AuthModule` falla al arrancar (no en el primer
request — en el `InstanceLoader`, al construir `JwtKeyGetter`) si
`SUPABASE_URL` no está definido — fail-fast consistente con la decisión
de fallar cerrado de la migración a JWKS.

Quedó una transacción de humo en el Postgres local (`budget_test`) que
no se pudo limpiar: `entries` es inmutable por diseño (R5/R6, ver
ARCHITECTURE.md §3.4) — un `DELETE` directo lo bloquea con
`fn_entries_immutable()`. Es una sola transacción de un `userId`
aleatorio que ningún test toca (todo filtra por `user_id`, S-R3);
forzar su borrado habría significado desactivar un trigger de
seguridad real solo por prolijidad. Se dejó ahí a propósito, no por
descuido.

### Resultado final — los cinco, cada uno por separado

```
npm run test:integration:auth       → 5 suites, 22/22 ✅
npm run test:integration:api:core   → 7 suites, 74/74 ✅
npm run test:integration:api:domain → 14 suites, 183/183 ✅
npm run test:unit                   → 9 suites, 66/66 ✅
npm run test:integration:db         → 14 suites, 124/124 ✅ (123 + T-K01b nuevo)
npx tsc --noEmit                    → limpio
```

### Documentos — lista de correcciones entregada a Luis, sin editarlos

`ARCHITECTURE.md` §3.12 (reescrita) y el pendiente #7 de la lista
numerada (marcado resuelto in-place, sin renumerar); `TASK-db.md`
(nueva fila 08 en la tabla de migraciones, U21 actualizado, U22
aclarado, P-07 marcado resuelto); `API-CONTRACT.md` §10.3 y §16.1
(el flujo de onboarding gana dos pasos: crear categorías/fuente de
ingreso antes de las cuentas reales). Ninguno de los tres se editó
directamente — el agente nunca toca `ARCHITECTURE.md`, y para estos
dos (`TASK-db.md`, `API-CONTRACT.md`) Luis pidió la lista aparte para
aplicarla él mismo. `TASK-api.md` (documento de trabajo activo de esta
tarea) sí se editó directo, igual que en sesiones anteriores.

## 2026-08-15 — Migración de `SupabaseAuthRepository` a JWKS (ES256): las cinco condiciones de paro en verde

**Por qué:** al levantar el backend real contra Supabase (ver entrada
anterior de "Cableado real de la aplicación"), Luis pegó un access token
real del dashboard para probarlo — resultó firmado `ES256`, no `HS256`.
El proyecto ya había migrado a **JWT Signing Keys** (llaves asimétricas),
y el "Legacy JWT Secret" que `TASK-auth.md` asumía como mecanismo de
verificación **nunca verificó tokens de usuario** — solo las API keys
(`anon`/`service_role`), confirmado en el dashboard real. `jwt.verify(token,
secret)` con un secret compartido no tiene forma de funcionar contra un
token `ES256`: no es un problema de qué secret poner, es que el modelo
completo dejó de aplicar.

### Ciclo completo: propuesta → tests → revisión → implementación

1. **Propuesta** (sin código): `jose` + `createRemoteJWKSet`/`createLocalJWKSet`,
   con `JWTVerifyGetKey` inyectado por constructor en `SupabaseAuthRepository`
   (nunca construido adentro — D1). Decisión explícita presentada, no
   tomada por el agente: si la descarga del JWKS falla, **fallar
   cerrado** — es el default de `jose` sin código propio, y el caso que
   protege (revocación de emergencia de una llave) hace que "disponible
   pero inseguro" sea peor que "caído un rato". Luis la confirmó.
2. **Tests primero, sin implementación** — reescritos: `test/setup/auth/jwt.ts`
   (dos llaves EC P-256 generadas al cargar el módulo, firma con
   `jsonwebtoken` — **no** con `jose`, para que `signValidToken` siga
   siendo síncrona y `bearerFor` no tuviera que volverse `async` en cada
   uno de los ~270 call sites de la suite), `test/setup/auth/test-app.ts`
   y `test/integration/api/_helpers/app.ts` (registran/overridean
   `'JwtKeyGetter'` con `createLocalJWKSet`, sin red). Nuevos:
   `test/setup/auth/mock-jwks-server.ts` (HTTP local real, JWKS mutable,
   puede simular fallo de red) y
   `test/integration/auth/jwks-verification.integration.spec.ts` (5 casos:
   llave conocida, kid desconocido, fetch fallido → rechaza, cooldown
   respetado, rotación exitosa). Verifiqué las 4 mecánicas de `jose`
   (fetch feliz/roto, cooldown, rotación) con un script suelto antes de
   escribir el spec final — los tiempos y conteos salieron exactamente
   como se esperaba (fetch roto: 2ms, no cuelga).
3. **Revisión de Luis** — aprobó los tests tal cual, con las correcciones
   de `ARCHITECTURE.md`/`TASK-auth.md`/`TASK-api.md` ya aplicadas por él
   (el agente nunca edita `ARCHITECTURE.md`; para este loop, tampoco los
   otros dos documentos — se le entregó la lista de correcciones exacta,
   él las aplicó).
4. **Loop de implementación**, un cambio por vuelta:
   - `SupabaseAuthRepository`: constructor con `@Inject('JwtKeyGetter')`,
     `validateToken` vía `jose.jwtVerify(token, this.getKey, {algorithms:['ES256']})`.
     Verificado en aislamiento contra `jwks-verification.integration.spec.ts`
     antes de tocar nada más — 5/5 al primer intento.
   - `AuthModule`: provee `'JwtKeyGetter'` vía `createRemoteJWKSet` sobre
     `${SUPABASE_URL}/auth/v1/.well-known/jwks.json` — deriva el endpoint
     de `SUPABASE_URL` (que `TASK-auth.md` ya pedía para el MCP, nunca
     antes consumida por el backend) en vez de pedir una URL nueva.

### Dos hallazgos durante la vuelta de verificación — ninguno es JWKS, ambos bloqueaban `:core`/`:domain`

- **`BoomModule`** (`test/integration/api/core/errors.integration.spec.ts`,
  Grupo Q) armaba su propio `{provide:'IAuthRepository', useClass:
  SupabaseAuthRepository}` a mano, sin importar `AuthModule` — no estaba
  en la lista de archivos revisados, así que se reportó antes de tocarlo.
  Luis eligió la opción de fondo sobre el parche rápido: en vez de
  agregarle su propio `'JwtKeyGetter'` local (que hubiera dejado tres
  lugares que recordar sincronizados — ya mordió una vez en este mismo
  cambio), `BoomModule` pasa a **importar `AuthModule`** real, igual que
  cualquier módulo de dominio. Una sola forma de obtener el repositorio,
  un solo lugar (`_helpers/app.ts`) donde se overridea la llave.
- **`T-R09 (recurring.confirm.json)`** — deriva de calendario, no
  relacionado con JWKS: `isDue = nextDueOn <= today` contra el reloj
  real; el fixture se congeló con `isDue:false` cuando "hoy" era anterior
  a `2026-08-15`, y la fecha real del sistema ya llegó ahí. El mecanismo
  `dateKeys` existente (para `recurring.list.json`) solo normaliza
  **strings**, no booleanos. Se sacó `recurring.confirm.json` de la lista
  de comparación literal y se le dio su propio test: compara el resto del
  objeto contra el fixture tal cual, y verifica `isDue` por separado
  recalculándolo con `todayInTimezone` real — no compara contra un
  booleano congelado que se desincroniza con el calendario.

### Resultado final — los cinco, cada uno por separado

```
npm run test:integration:auth       → 5 suites, 19/19 ✅
npm run test:integration:api:core   → 7 suites, 74/74 ✅
npm run test:integration:api:domain → 14 suites, 183/183 ✅
npm run test:unit                   → 9 suites, 66/66 ✅
npm run test:integration:db         → 14 suites, 123/123 ✅
npx tsc --noEmit                    → limpio
```

Como se avisó de antemano: no hubo guardrails que se mantuvieran verdes
*durante* el proceso — el cambio toca `AuthGuard`, y toda la suite de
integración pasa por ahí. `:core` y `:domain` estuvieron en rojo la
mayor parte del loop (38/74 y 180/183 fallando en la primera corrida) y
solo importaba el estado final.

### Dependencia nueva

`jose@^5.10.0` en `dependencies` (no dev — se usa en producción, dentro
de `AuthModule`). **Deliberadamente v5, no la v6 más reciente**: v6 solo
publica build ESM (`webapi`), sin condición `require` explícita —
choca con `"module": "commonjs"` de este proyecto. Verificado
`require('jose')` funcionando antes de instalar.

### Docker, otra vez

Al arrancar `:auth` por primera vez en esta sesión, `docker ps -a` volvió
a salir vacío — tercera vez que pasa (ver la nota fija al inicio de este
archivo). Misma recuperación de siempre, sin sorpresas.

## 2026-08-13 (2) — Cableado real de la aplicación: `main.ts`, `app.module.ts`, verificado arrancando contra Postgres local

**Alcance:** lo que quedó pendiente desde TASK-auth — nadie había escrito
`src/main.ts` ni `src/app.module.ts` porque ningún test los necesitaba (el
arnés de test monta su propia app por archivo, `createTestApp(modules)`).
Con los 7 módulos de dominio ya implementados (sesión anterior), tocaba
componerlos en la aplicación real.

### Archivos nuevos

| Archivo | Contenido |
|---|---|
| `src/main.ts` | Primera línea `import './common/bootstrap/bigint-json-override'`, luego `NestFactory.create(AppModule)` + `setGlobalPrefix('api/v1')` + `ValidationPipe` global + `GlobalExceptionFilter` + `ProfileInterceptor`. Mismo patrón de instanciación directa (no por DI) que ya usaba `test/integration/api/_helpers/app.ts` — y por la misma razón: D4 impide que los módulos de dominio garanticen esos providers en su propio grafo. |
| `src/app.module.ts` | Los 7 módulos de dominio (`Profile`, `Accounts`, `Categories`, `Transactions`, `Budget`, `Recurring`, `Insights`) + los 4 compartidos (`AccountsDataModule`, `QueriesModule`, `LedgerModule`, `PeriodsDataModule`). |
| `src/auth/auth.module.ts` | Ya existía, completo — no necesitó cambios. |
| `src/common/validation/validation-exception-factory.ts` | Extraído del arnés de test: `main.ts` y `_helpers/app.ts` ahora importan la misma función en vez de tener dos copias que solo podían divergir (mismo argumento que ya justificaba la estructura de `bigint-json-override.ts`). |
| `tsconfig.build.json` | `rootDir`/`include` acotados a `src/` (el `tsconfig.json` raíz compila `test/` y `scripts/` también — correcto para `tsc --noEmit`, pero generaría un `dist/` inflado si se usara para build real). |

**`package.json`** — no existía forma de arrancar el servidor (`npm run
dev` de `CLAUDE.md` no tenía script real detrás). Se agregaron `build`
(`tsc -p tsconfig.build.json`), `dev` (build + `node dist/main.js`) y
`start`. **Sin `ts-node` ni `tsx` para correr `main.ts`**: ninguno de los
dos estaba instalado, y `tsx` (esbuild) no soporta
`emitDecoratorMetadata` — la mitad de la DI de Nest en este proyecto
depende de esa metadata (constructores sin `@Inject()` explícito,
resueltos por tipo). Compilar con el compilador real de TypeScript y
correr el JS con `node` evita ese riesgo por completo.

### Verificación — no hay test que cubra esto, se verificó a mano

1. `npx tsc --noEmit` limpio.
2. `npm run build` compila sin errores.
3. Servidor arrancado de verdad (`node dist/main.js`) contra el Postgres
   local de Docker (`localhost:5433/budget_test` — el mismo que usa
   `.env.test`, confirmado comparando ambos archivos). Los 61 endpoints
   quedaron mapeados en el log de arranque de Nest.
4. **Petición sin token** a `/api/v1/me` y `/api/v1/accounts` → `401`
   (`AuthGuard` corriendo). Ruta sin el prefijo (`/accounts`, sin
   `/api/v1`) → `404` (`setGlobalPrefix` corriendo).
5. **Round-trip autenticado completo** contra datos reales: JWT firmado
   con el mismo secret de prueba de `.env.test`, un `auth.users` insertado
   a mano (mismo mecanismo que usan los fixtures de test,
   `test/setup/apply-auth-stub.ts`) —
   - `GET /me` → `200`, con upsert real de `profiles` (`ProfileInterceptor` + `EnsureProfileExistsService` corriendo contra Postgres de verdad).
   - `POST /accounts` → `201`, con `balanceCents:"0"` como **string** — confirma que el override de `BigInt.prototype.toJSON` sí está activo en el bootstrap real, no solo en el de test.
   - `GET /accounts` → `200`, trae la cuenta recién escrita.
   - `GET /insights/unassigned-funds` → `200`, F3 corriendo contra la base real.
   - `POST /accounts` con un campo no declarado (`bogus`) → `400 VALIDATION_FAILED` con `details:[{field:"bogus",...}]` — confirma el `ValidationPipe` + `exceptionFactory` reales.
6. Antes de encontrar el `auth.users` correcto, la primera petición
   autenticada dio `500` — **correcto y esperado**: un `userId` de
   `crypto.randomUUID()` sin fila en `auth.users` viola la FK de
   `profiles`. Sirvió además para confirmar que `GlobalExceptionFilter`
   escribe a `ErrorLog` en el bootstrap real (`SELECT * FROM error_log`
   mostró el `PrismaClientKnownRequestError` completo, con `context` =
   la ruta) — el mecanismo best-effort de logging funciona igual que en
   test.
7. Limpieza: se borraron las filas de prueba (`accounts`, `profiles`,
   `auth.users`, `error_log`) del Postgres local después de verificar —
   es la misma base que usan los tests, no debía quedar basura ahí.
8. Las cinco condiciones de paro, re-corridas después de todo lo anterior: `test:integration:api:domain` 14/14 (183/183), `test:unit` 9/9 (66/66), `test:integration:api:core` 7/7 (74/74), `test:integration:db` 14/14 (123/123), `test:integration:auth` 4/4 (14/14) — sin regresión.

### Hallazgo no documentado antes

`.env` (desarrollo real) y `.env.test` apuntan al **mismo** Postgres local
(`localhost:5433/budget_test`) — no son bases distintas, son el mismo
contenedor Docker con dos nombres de variable distintos. Cualquier
verificación manual contra "Postgres local" (como esta sesión) está
tocando la misma base que corren los tests — limpiar después es
obligatorio, no opcional, o el siguiente `npm run test:integration:db`
podría ver filas que ningún test sembró.

### Estado final

El backend tiene ahora una aplicación real arrancable, no solo una suite
de tests que monta apps efímeras. `npm run dev` (una vez agregado el
script) es lo que `CLAUDE.md` siempre dijo que existía.

## 2026-08-13 — TASK-api.md, loop de implementación A07–A11: **las cinco condiciones de paro en verde**

**Alcance:** implementación completa de `TransactionsModule` (A07),
`BudgetModule` (A08), `RecurringModule` (A09), `InsightsModule` (A10) y
verificación de contrato (A11), sobre la suite de tests escrita en las
tres sesiones previas del loop 2. Un cambio pequeño por vuelta, guardrails
verificados en cada uno. `PeriodsDataModule` (A01b) se construyó primero
como infraestructura compartida — la bloqueaban A07, A08 y A09 por igual.

### Resultado final de las cinco condiciones de verificación

```
npm run test:integration:api:domain → 14 suites, 183/183 ✅
npm run test:unit                   → 9 suites, 66/66 ✅
npm run test:integration:api:core   → 7 suites, 74/74 ✅ (guardrail, sin regresión)
npm run test:integration:db         → 14 suites, 123/123 ✅ (guardrail, sin regresión)
npm run test:integration:auth       → 4 suites, 14/14 ✅ (guardrail, sin regresión)
```

### Módulos entregados

| Módulo | Notas |
|---|---|
| `src/shared/periods-data/` (A01b) | `IBudgetPeriodRepository` con `runInTransaction` para orquestar algoritmos multi-paso desde el Service sin importar `PrismaClient` (D1). `findPeriodCoveringDate` (cualquier estado) vs `findOpenPeriodCoveringDate` (solo `closed_at IS NULL`) — la distinción importó dos veces esta sesión (T-S14, dashboard de insights). |
| `TransactionsModule` (A07) | Los nueve endpoints de escritura + `GET`/`PATCH`. `resolveLateCaptureCompensation` (§2.3) y `validateAndLoadAccounts` (§6.7 pasos 2-7) viven en `shared/ledger/` porque `RecurringModule` los reusa tal cual, no reimplementados. |
| `BudgetModule` (A08) | `periods.service.ts` (cierre atómico con `lockForUpdate` + `SET CONSTRAINTS ALL IMMEDIATE`), `allocations.service.ts` (delta calculado dentro de la transacción, después del `SELECT ... FOR UPDATE`, nunca antes). |
| `RecurringModule` (A09) | `confirm()` reusa `buildExpenseEntries`, `resolveLateCaptureCompensation`, `validateAndLoadAccounts` y `ITransactionRepository.createWithEntries` directamente — cero código de ledger propio. Solo avanza el template (`advanceAfterConfirm`) cuando `result.created === true`, para no avanzar dos veces en una recuperación por idempotencia. |
| `InsightsModule` (A10) | Sin repository propio — compone F1-F4 vía `QueriesModule` (D4, §6.10: "insights no calcula nada"). `dashboard` resuelve el periodo actual con `findPeriodCoveringDate` (mismo criterio que `GET /periods/current`), no `findOpenPeriodCoveringDate`. |
| A11 | Sin código de dominio — solo `contract-fixtures.integration.spec.ts` corriendo contra los 7 módulos juntos por primera vez. Fue la que encontró el endpoint faltante de `/accounts/{id}/ledger` (ver abajo). |

**Relocaciones a infraestructura compartida (D4):** un módulo de dominio no
puede importar la excepción o el DTO de otro. Se movieron a `shared/`
porque más de un módulo de dominio los necesitaba tal cual:

- `AccountNotFoundException`: `accounts/exceptions/` → `shared/accounts-data/exceptions/` (la necesitan `TransactionsModule` y `RecurringModule`).
- `TransactionResponseDto`/`BudgetImpactDto`: `transactions/dto/` → `shared/ledger/dto/` (la respuesta de `RecurringModule.confirm()` tiene la misma forma).
- `PeriodResponseDto`: `budget/dto/` → `shared/periods-data/dto/` (la necesita `InsightsModule` para el bloque `period` del dashboard — aunque con una forma más chica, ver hallazgo abajo).
- `PeriodNotFoundException` y `deriveCategoryStatus`: ya vivían en `shared/` desde antes de esta sesión (`periods-data/exceptions/`, `queries/category-status.ts`), reusados tal cual por `InsightsModule`.

### Dos bugs de implementación encontrados y corregidos (no de test)

1. **`PeriodsController.close()` y `AllocationsController.move()` sin `@HttpCode(200)`** — Nest devuelve `201` por default en `POST`; TASK-api.md pedía `200` en ambos. Encontrado y corregido directo, sin necesitar autorización (es código de `src/`, no un test).
2. **`GET /accounts/{id}/ledger` documentado en TASK-api.md §6.5 pero nunca implementado** — `AccountsController` no tenía la ruta, `AccountsService` no tenía el método. Solo lo encontró `contract-fixtures.integration.spec.ts` (A11), la primera vez que los 7 módulos de dominio corrieron juntos: ninguna suite de un solo módulo lo iba a golpear, porque ninguna prueba de `AccountsModule` en aislamiento pedía ese endpoint. Corregido con el mismo patrón que `CategoriesService.ledger()` (mismo `findEntriesByAccountCursor`, mismo manejo de cursor) — **vale la pena recordar esto**: una suite que compone todos los módulos encuentra huecos de contrato que ninguna suite aislada puede ver, aunque cada módulo individualmente esté "completo" y en verde.

### Correcciones de test — ocho en total, todas autorizadas y documentadas aquí para que se puedan rastrear

| ID | Diagnóstico | Corrección |
|---|---|---|
| T-F07 | El helper `createExpense()` ignoraba el parámetro `auth`, así que la petición nunca llegaba como el usuario equivocado — el 404 esperado nunca se ejercía por la ruta real. | Se agregó el parámetro `accounts` al helper; el call site de T-F07 pasa `fixture.b.accounts` para sí golpear la ruta real de "revertir la transacción de otro usuario". |
| T-I03 | Encadenaba un `cursor` de una página que no existía; `encodeURIComponent(null)` produce el string literal `"null"`, que rompe la decodificación. | Se reemplazó por `expect(page2.body.nextCursor).toBeNull()`. Verificado que sigue cruzando el límite real de página con dos transacciones de mismo `bookedAt` — si dejara de cruzar ese límite, el test pasaría sin probar nada. |
| T-I09 | Contaba mal las cuentas de fixture preexistentes: esperaba `total: 60`, el total real con las 3 cuentas de fixture es `63`. | `total: 63`, con comentario explicando el conteo. |
| T-L12 | El setup insertaba una asignación por SQL directo en un periodo creado *ya cerrado* — R11 bloquea `INSERT`, no solo `UPDATE`/`DELETE`, así que el propio setup del test fallaba antes de llegar al caso que quería probar. | El periodo se crea abierto, se inserta la asignación, se cierra por `UPDATE` aparte, y solo entonces se intenta el `DELETE` que el test realmente quería ejercer. |
| Cents ×10 (`period-close`×4, `late-capture`×6) | `test/setup/db.ts` registra un parser global de tipo para OID 20 (bigint) que convierte a `Number` en el pool `pg` compartido — usado por los helpers de lectura SQL directa. Es distinto de la ruta HTTP/JSON, que sí serializa bigint como string vía `BigInt.prototype.toJSON`. Diez aserciones comparaban una lectura por SQL directo contra un literal string. | Se agregó `test/integration/api/_helpers/cents.ts` con `expectCents(actual, expected)`, que normaliza ambos casos. **Por instrucción explícita: no se retrocedió a los tests ya en verde — el helper se usa solo de aquí en adelante.** Va a volver a pasar en cualquier módulo nuevo que lea montos por SQL directo. |
| T-O02 | Intentaba archivar por SQL directo una cuenta `asset` con saldo distinto de cero. R8 es un trigger de base de datos (`BEFORE UPDATE ON accounts`) — dispara sobre **cualquier** `UPDATE` que ponga `archived_at`, sin importar si viene de HTTP o de SQL crudo. No hay forma de "saltárselo". | Se siguió la secuencia ya correcta de `T-OC02` (loop 1): fondear → drenar a cero → archivar (R8 lo permite con saldo cero) → fondear otra vez (R8 solo dispara en la transición de `archived_at`, no en entries posteriores). Mismo estado final, alcanzado por la única vía que existe. |
| T-R12 | El regex `/budget_entries|budgetEntry\.(create\|...)/ ` detectaba **cualquier mención** del string `budget_entries` — un nombre de constraint en un comentario, un `SELECT` de lectura en `hasLiveAllocationsInOpenPeriods` — no solo escrituras. | Regex más angosto: solo `INSERT INTO`/`UPDATE`/`DELETE FROM budget_entries` en SQL crudo, o los métodos tipados de escritura de Prisma (`budgetEntry.create/createMany/update/updateMany/upsert/delete/deleteMany`). Mismo patrón que T-I03/T-I09: la aserción no distinguía "el string aparece" de "este archivo escribe". |

### T-S14 — resuelto, no es una corrección de test sino un hallazgo sobre el diseño

`T-S14` probaba una carrera real por timing (`Promise.all` con `pg_sleep`)
entre cerrar el periodo objetivo y el `INSERT` del compensatorio. Cuatro
intentos con distintos tiempos de espera (50ms, 10ms, 1ms, sin espera)
nunca lograron disparar el choque contra R11 — siempre ganaba el gasto
(`201`). Por instrucción de Luis, en vez de agregar un lock para hacerlo
testeable (**descartado explícitamente** — "dejar que el test dicte el
diseño"), se verificó empíricamente cuál de dos casos aplicaba: cerrar el
periodo **antes** de la petición (sin carrera) y ver si el Service filtra
`closed_at` al resolver "el periodo abierto actual".

**Sí filtra** (`findOpenPeriodCoveringDate`, confirmado en el código y
verificado dos veces empíricamente): cerrar antes da `uncompensated`
(T-S05), no el choque contra R11 — el Service nunca reintenta un periodo
que su propia lectura ya descartó. La ventana real solo existe en el
intervalo de milisegundos entre esa lectura y el `INSERT`, dentro de la
misma petición, y no es reproducible desde fuera de forma determinista.
`T-S14` se retiró de la suite; `TASK-api.md` §2.3 y §5.1 tienen una nota
explicando el razonamiento completo y por qué la ventana queda verificada
por revisión de código, no por una corrida reproducible.

### Orden de `movements` — decisión de diseño nueva, no solo una corrección

`contract-fixtures.integration.spec.ts` esperaba un orden fijo en
`movements` (pagador primero, categoría después) que la lectura no
garantizaba: `entries.id` es un UUID aleatorio y `created_at` es el mismo
timestamp de transacción para todos los entries de una escritura — no hay
columna que reconstruya el orden de inserción. En vez de ajustar el test
a "sin orden garantizado", Luis decidió que **sí hace falta una garantía
de orden** (un cliente necesita pintar la misma transacción igual en dos
cargas). Regla adoptada: `amount_cents` ascendente (de dónde salió el
dinero, luego a dónde fue), con `id` ascendente como desempate para
splits simétricos. Implementado en
`TransactionDetailResponseDto.from()` (único punto de paso para
`GET /transactions` y `GET /transactions/{id}`) y documentado como
contrato, no solo como comportamiento, en `TASK-api.md` §6.7 y
`API-CONTRACT.md` §11.9.

### Hallazgos no documentados en ningún lado antes de esta sesión

- **`test/setup/db.ts` tiene un parser global de tipo para OID 20** que
  convierte bigint a `Number` en el pool `pg` compartido por los helpers
  de test — deliberado, pero es una ruta de serialización distinta de la
  HTTP/JSON (que pasa por `BigInt.prototype.toJSON` y da string). Cualquier
  test nuevo que lea montos por SQL directo tiene que usar `expectCents`.
- **Los triggers deferred son solo R1, R2, R4 y R9** (confirmado leyendo
  la tabla de 9 triggers de ARCHITECTURE.md) — R3, R5, R6, R7, R8, R10 y
  R11 son `BEFORE` inmediatos. Importa porque el error de un trigger
  deferred sale en el `COMMIT`, no en el `INSERT`/`UPDATE` — un test que
  espere el error antes de tiempo falla aunque el trigger esté perfecto.
- **R8 (archivar con saldo cero) es un trigger de base de datos**, no una
  regla de Service — dispara sobre cualquier `UPDATE` a `archived_at`,
  vía HTTP o SQL directo por igual. No hay forma de "saltárselo" con SQL
  crudo para los tipos `asset`/`receivable`/`liability`. La única vía para
  llegar a "archivada con saldo distinto de cero" es archivar con saldo
  cero y *después* fondear de nuevo (T-OC02, T-O02).
- **Una suite que compone todos los módulos de dominio juntos encuentra
  huecos de contrato invisibles para cualquier suite de un solo módulo**
  — el caso de `/accounts/{id}/ledger` (arriba). Vale la pena que A11
  corra pronto en el loop, no solo al final, la próxima vez que haya un
  proyecto con esta forma.

### Estado final

Los cinco módulos de dominio de loop 2 (`transactions`, `budget`,
`recurring`, `insights`) más `periods-data` (A01b) están implementados,
compilan sin errores (`tsc --noEmit` limpio) y las cinco condiciones de
paro están en verde. El proyecto completo (loop 1 + loop 2) tiene su
backend y capa de datos terminados según `TASK-db.md`, `TASK-auth.md` y
`TASK-api.md`. Frontend sigue fuera de alcance de este repo.

## 2026-08-10 (3) — TASK-api.md, loop 2 sesión 3/3 (A09 · A10 · A11): suite de tests escrita — **loop 2 completo**

**Alcance:** A09 (`recurring`, Grupo N), A10 (`insights`, Grupo O) y A11
(verificación de contrato, el resto de Grupo R). Con esto **la suite de
tests de todo el proyecto queda escrita** — quedan las tres sesiones del
loop 2 cerradas; el siguiente paso es el loop de implementación completo
sobre A07–A11. **No se implementó nada de `src/` en esta sesión.**

### Resultado de las seis condiciones de verificación

```
npm run test:integration:api:domain → 14 suites, 14 en rojo, 0 tests corridos (compile-crash por diseño)
npm run test:integration:api:core   → 7 suites, 74/74 ✅ (sin regresión)
npm run test:unit                   → 9 suites, 66/66 ✅ (sin regresión)
npm run test:integration:db         → 14 suites, 123/123 ✅ (guardrail, sin regresión)
npm run test:integration:auth       → 4 suites, 14/14 ✅ (guardrail, sin regresión)
npx tsc --noEmit -p tsconfig.json   → exactamente 18 TS2307 (12 ya conocidos de sesiones 1-2 + 6 nuevos: recurring×1, insights×1, contract-fixtures×4), cero errores más
```

### Archivos entregados

| Archivo | Grupo | IDs |
|---|---|---|
| `test/integration/api/domain/recurring.integration.spec.ts` | N | T-N01–N14 |
| `test/integration/api/domain/insights.integration.spec.ts` | O | T-O01–O15 |
| `test/integration/api/domain/contract-fixtures.integration.spec.ts` | R (resto) | T-R01–R04, R09 (×25, uno por fixture), R11, R12 |
| `test/fixtures/contract/*.json` (25 archivos nuevos) | — | consumidos por T-R09 |

**Recordatorio de alcance de Grupo R:** T-R05/R06/R07/R08/R10 ya se
cerraron en el loop 1 (`core/contract-static.integration.spec.ts`) — ese
archivo deja escrito que el resto de Grupo R vive aquí porque necesita
"la superficie completa" de los 7 dominios. No se duplicó nada.

**Sin helpers nuevos** — todo lo que hizo falta ya existía de las
sesiones 1 y 2 (`_helpers/periods.ts` para `seedLateCapturePeriods` y
`todayInMexicoCity`, `setup/ledger.ts`, `setup/recurring.ts`).

### El escenario de T-R09, en resumen

25 fixtures requieren 25 respuestas reales comparadas tras normalizar.
Se construyeron 5 sub-escenarios con usuarios frescos independientes
dentro de un solo `beforeAll` (las peticiones se guardan en un mapa
`responses`; las aserciones viven en `it()`s separados — un `beforeAll`
que hace `expect()` directamente habría hecho fallar el describe entero
en vez de reportar cada fixture por separado):

1. **General** — cuentas, un gasto, asignaciones, periodos, fuentes de
   ingreso, un recurrente y su confirmación, dos errores, perfil.
2. **Cierre** — mismo patrón que T-M12 (Servicios `accumulate` con
   sobrante, Comida `reset` con déficit) → `periods.close-preview.json`,
   `periods.close.json`, `errors.period-closed.json`.
3. **Canónico de §3.9** (T-O04, reusado tal cual) →
   `insights.account-balances.json`, `insights.category-balances.json`,
   `insights.unassigned-funds.json` = `"740000"`.
4. **Dashboard** — variante propia con un gasto en hueco además del
   escenario canónico, para que los cuatro bloques de
   `insights.dashboard.json` sean consistentes entre sí en una sola
   llamada real (`unassignedCents` sale `"798500"` aquí, no `"740000"` —
   es un escenario distinto al #3, con una cuenta de más tocada).
5. **Captura tardía** — `_helpers/periods.ts` (mismo patrón de la sesión
   1) para `transactions.expense-create-late.json`.

### Inferencias — lo que no estaba en la documentación

1. **Normalización extendida a tres categorías, no dos.** `TASK-api.md`
   §11.1 solo pide placeholder para uuid y timestamp, y dice "todo lo
   demás se compara literal, incluidos los montos" — tomado al pie de la
   letra, eso incluiría `message`. Pero §7.1 dice explícitamente
   "Programa contra `code`, nunca contra `message`... puede cambiar de
   redacción sin aviso". Ambas reglas no pueden ser ciertas a la vez para
   un fixture versionado — se resolvió a favor de §7.1 (más específica y
   más antigua en el documento): `message` y `constraint` se normalizan a
   `"<message>"` igual que un uuid. Además, dos fixtures puntuales
   (`recurring.list.json`, `transactions.expense-create-late.json`)
   normalizan un tercer campo por nombre (`nextDueOn`/`bookedAt`) a
   `"<date>"` porque son inherentemente relativos a "hoy" en el escenario
   de este archivo — mismo principio que ya forzó `_helpers/periods.ts`
   en la sesión 1, aplicado ahora también a fixtures.
2. **`GET /periods/{id}/allocations` responde `{allocations:[...]}`, no
   `{data:[...]}`.** El contrato nunca muestra el JSON de este endpoint
   (solo el de crear una asignación individual). Se infirió por analogía
   directa con el único precedente que el documento sí da para una lista
   **sin paginar**: `GET /insights/unbudgeted-transactions` responde
   `{transactions:[...]}`, no `{data:[...]}` — nombre del recurso, no
   genérico. Si la implementación real usa `data`, es un ajuste de una
   línea en el fixture, no un rediseño.
3. **Orden de listados sin criterio documentado** (`GET /accounts`,
   `GET /insights/account-balances`, `GET /periods`): se asumió orden de
   creación para los dos primeros y "más reciente primero" para periodos
   (única vez que el contrato lo dice explícitamente, en §12.1). Si el
   orden real difiere, T-R09 falla con un diff claro y legible, no en
   silencio.
4. **`nextDueOn` al CREAR un template (sin `lastConfirmedOn` previo)
   se calcula con "hoy" como referencia.** `TASK-api.md` solo documenta
   la fórmula de avance para `confirm` (usa el `lastConfirmedOn` recién
   fijado); para la creación solo dice "si no lo mandas, el servidor lo
   calcula", sin decir contra qué fecha. "Hoy" es la única referencia
   disponible sin una confirmación previa — T-N01 lo calcula invocando
   la función real `nextDueOn()` (ya implementada, U08b) en vez de
   hardcodear una fecha, así que la aserción es correcta sin importar
   qué día corra la suite.

### Un hallazgo — encontrado y corregido con Luis en esta misma sesión

**T-U24, tal como estaba escrito, no coincidía con el comportamiento ya
validado de la función real.** La fila decía `nextDueOn(31, '2026-01-31')
→ 2026-03-31`. La función `nextDueOn` (U08b, ya implementada y ya
probada por 66 tests unitarios en verde, incluida `T-I02` en
`test/unit/next-due-on.spec.ts`) da **`2026-03-01`** para esa llamada
exacta — `2026-03-31` solo sale de un **segundo** paso encadenado, usando
el resultado del primero como nueva referencia (exactamente lo que
describen CA-22 y T-N09: plantilla con `lastConfirmedOn:2026-01-31`,
confirmada de nuevo el `2026-03-01`, avanza a `2026-03-31`). Nunca fue un
hueco: el comportamiento correcto ya estaba cubierto por `T-I02` (la
llamada directa) y por `T-N09` de esta sesión (el escenario completo de
dos pasos) — era la fila la que mezclaba ambos pasos en una sola
notación inconsistente. **Corregido en `TASK-api.md` §11, Grupo U**:
T-U24 ahora dice `2026-03-01` (la llamada directa, real), con una nota
debajo de la tabla que remite el caso encadenado a CA-22/T-N09. Ningún
test ni código cambió — era exclusivamente un error de notación del
documento.

### Recuento final de cobertura — las tres sesiones del loop 2, todo el proyecto

Comparación programática (`grep` de IDs en las tablas de `TASK-api.md`
contra `it()`/`it.each()` reales en `test/unit/`, `src/**/*.spec.ts`,
`test/integration/api/core/` y `test/integration/api/domain/`):

```
IDs documentados en TASK-api.md:  259
IDs con test escrito:             258
Diferencia:                       T-U24 (ver hallazgo arriba — cubierto
                                   en sustancia por T-I02 + T-N09, no
                                   es un hueco real)
IDs en el código que NO están
  en TASK-api.md (typos):         0
```

**Por grupo** (26 IDs de Grupo U son puros — 4 no viven en un `.spec.ts`
propio: T-U24 según el hallazgo de arriba, T-U08b… — cobertura 100% en
todos los demás grupos, loop 1 y loop 2, sin excepción). Todos los 21
grupos de `TASK-api.md` con al menos un ID (U, A-core, A-http, B–I, K–S,
O-core, P, Q) tienen sus IDs contabilizados 1:1 contra el archivo que
`§11.0` les asigna — ninguno quedó sin destino, ninguno se escribió dos
veces.

### Qué sigue

**Las tres sesiones de tests del loop 2 están cerradas.** Todo
`test/integration/api/domain/` (14 archivos) y sus 25 fixtures de
contrato quedan en rojo por diseño, esperando A07–A11. El siguiente paso
es el loop de implementación: construir `TransactionsModule`,
`BudgetModule`, `RecurringModule`, `InsightsModule` y el módulo de
verificación de contrato, en ese orden de dependencias (§7 de
`TASK-api.md`), hasta que las seis condiciones de `§0.2` cierren en
verde. Antes de arrancar, Luis debe decidir el hallazgo de T-U24 de
arriba.

## 2026-08-10 (2) — TASK-api.md, loop 2 sesión 2/3 (A08 · budget): suite de tests escrita, sin implementación

**Alcance:** solo A08 (módulo `budget`) — Grupos K (periodos), L
(asignaciones), M (cierre de periodo). Grupos N/O/R quedan para la
sesión 3 (A09–A11), según `TASK-api.md` §11.0. **No se implementó nada
de `src/`.**

### Resultado de las seis condiciones de verificación

```
npm run test:integration:api:domain → 11 suites, 11 en rojo, 0 tests corridos (compile-crash por diseño, igual que sesión 1)
npm run test:integration:api:core   → 7 suites, 74/74 ✅ (sin regresión)
npm run test:unit                   → 9 suites, 66/66 ✅ (sin regresión)
npm run test:integration:db         → 14 suites, 123/123 ✅ (guardrail, sin regresión)
npm run test:integration:auth       → 4 suites, 14/14 ✅ (guardrail, sin regresión)
npx tsc --noEmit -p tsconfig.json   → exactamente 12 TS2307 (los 9 de sesión 1 + 3 nuevos por BudgetModule), cero errores más
```

Los 3 archivos nuevos (`periods`, `allocations`, `period-close`) importan
`BudgetModule` (`src/budget/budget.module`, A08), que no existe todavía
— mismo patrón "rojo por diseño" que `TransactionsModule` en la sesión 1.
42 casos nuevos (`it()` reales, contados con `grep -c`): 14 (K) + 13 (L)
+ 15 (M).

### Archivos entregados

| Archivo | Grupo | IDs |
|---|---|---|
| `test/integration/api/domain/periods.integration.spec.ts` | K | T-K01–K14 |
| `test/integration/api/domain/allocations.integration.spec.ts` | L | T-L01–L13 |
| `test/integration/api/domain/period-close.integration.spec.ts` | M | T-M01–M15 |

**Sin helpers nuevos.** Todo lo que hizo falta ya existía de la sesión 1
(`_helpers/periods.ts` para `todayInMexicoCity`/`addDays`,
`_helpers/reject.ts`, `setup/ledger.ts` para `insertBudgetEntry`/
`insertBalancedTransaction`). Reusados tal cual, sin extender.

### Inferencias — lo que no estaba en la documentación

1. **T-K07 (zona horaria) — resuelto al 100%, no probabilísticamente.**
   Mi primer plan usaba solo `Pacific/Kiritimati` (UTC+14), que solo
   difiere de la fecha UTC cuando la hora UTC es ≥10:00 (~58% del día).
   Luis propuso la corrección: elegir en tiempo de ejecución entre
   `Pacific/Kiritimati` (hora UTC ≥10:00) y `Pacific/Niue`, UTC−11 (hora
   UTC <10:00) — las dos ventanas cubren las 24 horas sin hueco, así que
   la fecha local **siempre** difiere de la UTC sin importar cuándo corra
   la suite. El test siembra un periodo señuelo sobre la fecha UTC y
   confirma que `/periods/current` NO lo devuelve — la aserción que de
   verdad discrimina un bug de `now()::date`.
2. **Cada test de Grupo M usa su propio `seedFixtureCommitted()` fresco**,
   reusando directamente `p1`/`p2` del fixture (agosto 2026, ambos
   abiertos por default) en vez de sembrar periodos propios. A diferencia
   de Grupo S en la sesión 1, el cierre no depende de "hoy" — opera sobre
   periodos por `id` — así que no hace falta el patrón de
   `seedLateCapturePeriods`. Sí hizo falta para T-K05/T-K06/T-K07 (Grupo
   K), donde si depende de "hoy" — ahí se reusaron `todayInMexicoCity`/
   `addDays` ya exportados de `_helpers/periods.ts`.
3. **T-M01/T-M02/T-M05/T-M06 comparten un solo cierre** (un `beforeAll`
   anidado, cuatro categorías con los cuatro desenlaces posibles en la
   misma llamada a `POST /close`), en vez de cuatro cierres
   independientes — es el mismo escenario base que describe la tabla de
   Grupo M, y evita cuadruplicar el setup. T-M03/T-M04 (déficit) sí
   necesitan su propio fixture cada uno porque no pueden coexistir con el
   escenario de superávit de M01/M02 en la misma categoría.
4. **T-M14 reusa el fixture canónico de T-OC05 exactamente** (loop 1,
   `queries-repository.integration.spec.ts`: cash 1,000,000, Comida
   `reset` +150,000, Salud −30,000 → `unassignedFunds` = 740,000n) y
   deriva el valor esperado post-cierre a mano, con la fórmula de F3
   (§3.9): Comida se libera (+150,000 de vuelta a sin-asignar), Salud se
   arrastra a P2 sin cambio neto (sigue comprometida, solo cambia de
   periodo) → **890,000n**, delta exacto **+150,000n**. Es el número que
   Luis pidió no recalcular "desde cero" — se derivó de la definición
   documentada de F3, no se inventó.
5. **Verificaciones de F2/F3 vía `PrismaQueryRepository` directo**, mismo
   patrón que la sesión 1 (evita depender de `InsightsModule`/A10, sesión
   3, que no existe).

### Qué sigue

Sesión 3 del loop 2: Grupos N, O, R (con A09–A11 — `recurring`,
`insights`, verificación de contrato) en sus archivos correspondientes.
Cuando A08 exista, `late-capture...` y `allocations...`/`periods...`/
`period-close...` de esta sesión deberían dejar de fallar por
`BudgetModule` — a `late-capture` seguirá faltándole A07 y A09.

## 2026-08-10 — TASK-api.md, loop 2 sesión 1/3 (A07 · transactions): suite de tests escrita, sin implementación

**Alcance de esta sesión, tal como se acordó:** solo A07 (módulo
`transactions`) — Grupos B, C, D, E, F, I, S, más A-http (agregado tras
confirmar con Luis que quedaba huérfano si no se incluía aquí: tiene su
propio archivo en el mapeo de §11.0 y ejercita exactamente los mismos
endpoints de `/transactions/*` de esta sesión). Grupos K/L/M (sesión 2,
con A08) y N/O/R (sesión 3, con A09–A11) **no se tocaron** — ver
`TASK-api.md` §11.0. **No se implementó nada de `src/`.**

### Resultado de las seis condiciones de verificación

```
npm run test:integration:api:domain → 8 suites, 8 en rojo, 0 tests corridos (compile-crash por diseño — ver nota)
npm run test:integration:api:core   → 7 suites, 74/74 ✅ (sin regresión)
npm run test:unit                   → 9 suites, 66/66 ✅ (sin regresión)
npm run test:integration:db         → 14 suites, 123/123 ✅ (guardrail, sin regresión)
npm run test:integration:auth       → 4 suites, 14/14 ✅ (guardrail, sin regresión)
npm run test:integration:api        → 15 suites (7 pass + 8 fail), 74 tests (74 pass + 0) — suma EXACTA de :core + :domain
```

**Por qué `:domain` da "0 tests corridos" en vez de una lista de IDs en
rojo.** Los 9 archivos importan `TransactionsModule`
(`src/transactions/transactions.module`, A07) y `late-capture`/
`idempotency-http` además `RecurringModule` (`src/recurring/...`, A09) —
ninguno de los dos existe todavía. `ts-jest` no compila el archivo, Jest
lo reporta como "Test suite failed to run" con 0 tests contados, en vez
de tests individuales en rojo. **Es el mismo patrón, ya precedentado, de
la propia sesión de tests de loop 1**: `accounts.integration.spec.ts`
importó `AccountsModule` cuando tampoco existía, con el mismo efecto
("rojo por diseño", comentario textual en ese archivo). Verificado que no
hay ningún otro error escondido detrás del compile-crash: `npx tsc
--noEmit -p tsconfig.json` sobre **todo** el repo da exactamente 9
errores `TS2307`, uno por archivo (dos en `late-capture`, por los dos
módulos), y nada más — ni en los archivos nuevos ni en los helpers que
tocó esta sesión.

### Archivos entregados

**Helpers (extendidos, no duplicados):**
- `test/setup/fixture.ts` — `insertPeriod` acepta `closedAt?` opcional,
  retrocompatible (default `null`, mismo comportamiento de antes).
- `test/integration/api/_helpers/periods.ts` (nuevo) — `seedLateCapturePeriods`
  para Grupo S, ver inferencia #1 abajo.
- `test/integration/api/_helpers/reject.ts` (nuevo) — `expectRejection`,
  generaliza el patrón de una-sola-invocación + `code` + conteo
  antes/después que ya usaban los archivos de `core/` del loop 1.
- `test/setup/recurring.ts` (nuevo) — `insertRecurringTemplate`, INSERT
  directo (la tabla existe desde `TASK-db`; el módulo/endpoint no).

**Tests (`test/integration/api/domain/`), con su cobertura de IDs:**

| Archivo | Grupo | IDs |
|---|---|---|
| `transactions-expense.integration.spec.ts` | B | T-B01–B14 |
| `transactions-income-transfer.integration.spec.ts` | C | T-C01–C07 |
| `transactions-loans.integration.spec.ts` | D | T-D01–D08 |
| `transactions-opening-balance.integration.spec.ts` | E | T-E01–E08 |
| `transactions-reversal.integration.spec.ts` | F | T-F01–F11 |
| `transactions-query.integration.spec.ts` | I | T-I01–I10 |
| `late-capture.integration.spec.ts` | S | T-S01–S17 (incluye T-S10b) |
| `idempotency-http.integration.spec.ts` | A-http | T-A04, T-A05, T-A09, T-A20, T-A21, T-A22 |

82 casos en total (`it()` reales, contados con `grep -c`, no a ojo).
Confirmado por lectura, no por script —
`verify:coverage` (el script de cobertura) está acotado a los IDs de
`TASK-db.md` y no cubre esta capa; no existe un equivalente para
`TASK-api.md` todavía.

### Inferencias — lo que no estaba en la documentación y tuve que decidir

1. **Periodos de Grupo S sembrados relativos a "hoy" real, no a fechas
   fijas.** El fixture compartido (`test/setup/fixture.ts`) siembra
   `p1`/`p2` fijos en agosto 2026. Todo Grupo S depende de que "hoy"
   (resuelto por `profile.timezone`, nunca hardcodeado — §2.3, §5.5) caiga
   dentro de un periodo **abierto**; con la fecha real de esta sesión
   (agosto 2026), usar `p1`/`p2` tal cual habría dejado "hoy" dentro del
   periodo que Grupo S necesita **cerrado**. `seedLateCapturePeriods`
   (`_helpers/periods.ts`) siembra P1 = [hoy−30, hoy−1] cerrado y P2 =
   [hoy, hoy+29] abierto, calculados en `America/Mexico_City`, y
   soft-borra los `p1`/`p2` fijos del mismo usuario antes de insertar los
   suyos (si no, `budget_periods_no_overlap` los rechaza por traslape).
2. **T-C07, T-D02, T-D03, T-D06, T-S04, T-B13, T-B14, T-S15 verifican F2/F3/F4
   invocando `PrismaQueryRepository` directamente**, en vez de
   `GET /insights/*` (`InsightsModule`, A10, sesión 3) — mismo patrón que
   ya usa Grupo O-core del loop 1. Evita que estos archivos dependan de un
   módulo de otra sesión sin necesidad: la garantía que importa (el estado
   correcto en F2/F3/F4) es la misma, y el repository ya está construido y
   probado.
3. **T-S02 (loop 2, A08) reformulado a SELECT directo sobre
   `budget_entries`** en vez de `GET /periods/{id}/allocations`
   (`BudgetModule` no existe hasta la sesión 2) — verifica el mismo hecho
   (el compensatorio queda vigente en la lista de asignaciones del
   periodo) al nivel de dato, no de endpoint.
4. **T-S12 sí importa `RecurringModule`** (no existe hasta sesión 3) y usa
   `insertRecurringTemplate` (INSERT directo) para el fixture — a
   diferencia de T-S02, aquí no hay forma de probar el comportamiento real
   sin el endpoint de `confirm`, así que se dejó tal cual el documento lo
   pide. Su archivo (`late-capture...`) seguirá sin compilar hasta que
   A07 **y** A09 existan — aceptado, mismo patrón "rojo por diseño".
5. **T-D08 va a pasar en verde sin implementación propia**, igual que
   T-R10 en el loop 1: es un grep guardrail (`'Pérdidas'`/`'Perdidas'` no
   aparece en `src/`), verdadero hoy porque nada lo usa, y debe seguir
   siéndolo. No es una feature de A07. (En la práctica, hoy ni siquiera
   llega a correr solo — el archivo entero de Grupo D falla a compilar
   por `TransactionsModule`, así que no hay riesgo de falso verde en esta
   sesión.)
6. **T-S14 y T-A22 son carreras por timing real** (`Promise.all`, sin
   ningún hook para pausar el Service a medio camino — no existe
   documentado). Decisión tomada con Luis: mismo estilo que T-A07/T-A08
   del loop 1 (Grupo A-core), aceptando que puede ser intermitente en CI
   lento. T-S14 usa un `pg_sleep(0.05)` en la conexión que cierra el
   periodo para intentar caer dentro de la ventana entre la resolución del
   periodo y el INSERT del compensatorio — puede necesitar recalibrarse
   una vez que A07 exista de verdad y esa ventana se pueda medir.
7. **`GET /categories?periodId=`, `POST /categories/{id}/archive` y
   `GET /accounts` se importan reales** (`CategoriesModule`/`AccountsModule`,
   ya construidos en loop 1) en los archivos que los necesitan como
   verificación (T-E08, T-F08, T-I09, T-S03/S17) — no se mockean ni se
   reimplementan.

### Qué sigue

Sesión 2 del loop 2: Grupos K, L, M (con A08 — `budget`, periodos y
asignaciones) en `periods.integration.spec.ts`, `allocations.integration.spec.ts`,
`period-close.integration.spec.ts`. Cuando A08 exista, `late-capture...`
y `idempotency-http...` (de esta sesión) deberían dejar de fallar por
`BudgetModule`/`AccountsModule` — solo les faltará A07 (y a
`late-capture`, además, A09 en sesión 3).
previo fallido — resolver con
`npx dotenv -e .env -- npx prisma migrate resolve --rolled-back <nombre_de_la_migración>`
y reintentar `migrate deploy`.

## 2026-08-10 — TASK-api.md, loop 1 (A00–A06) CERRADO: las cuatro condiciones de paro en verde

### Estado del loop 1

**Cerrado.** Las cuatro condiciones de paro de `TASK-api.md` §0.1, cada una
corrida por separado:

```
npm run test:integration:api:core  → 7 suites, 74/74 ✅
npm run test:unit                  → 9 suites, 66/66 ✅
npm run test:integration:db        → 14 suites, 123/123 ✅ (guardrail — capa de datos, no debe cambiar)
npm run test:integration:auth      → 4 suites, 14/14 ✅ (guardrail — capa de auth, no debe cambiar)
npx tsc --noEmit                    → 0 errores, todo el repo, sin filtros
```

**Unidades completas:** A00 (infraestructura común), A01
(`AccountsDataModule`), A02 (`QueriesModule`), A03 (`LedgerModule`), A04
(`profile`), A05 (`accounts`), A06 (`categories` + `income-sources`).
Detalle de archivos en "Todo lo que quedó implementado" más abajo.

**Lo único deliberadamente diferido, y por qué no bloquea el cierre:**

- **`PeriodsDataModule` (A01b) no se construyó.** Ningún test de loop 1
  lo necesita: `PrismaTransactionRepository.createWithEntries()` recibe
  las compensaciones de captura tardía **ya resueltas** como parámetro —
  quien resuelve "¿qué periodo cubre esta fecha?" es el Service de
  `TransactionsService` (A07, loop 2), no el repository. Lo va a
  necesitar el loop 2 para arrancar A07/A09.
- **`ITransactionRepository` tiene 3 métodos sin test propio todavía**
  (`findManyByCursor`, `findEntriesByAccountCursor` solo se ejercita vía
  `/categories/{id}/ledger`, `findById`, `findByIdempotencyKey`,
  `findReversalOf`, `updateDescription`): están implementados (TypeScript
  obliga a implementar toda la interfaz), pero sin cobertura directa
  porque loop 1 no tiene endpoints de transacciones. El loop 2 (A07) los
  va a ejercitar por primera vez de verdad — revisarlos con cuidado ahí,
  no asumir que "compilan" significa "están bien".
- **Loop 2 completo (A07–A11) no ha empezado.** Grupos B/C/D/E/F/I/K/L/M/N/O/S
  + Grupo R contra fixtures, todos en `test/integration/api/domain/`
  (ese directorio no existe todavía).

T-R05/T-R06/T-R07 (D4: ningún módulo de dominio importa a otro; cero
`PrismaClient` en Service/Controller; cero vocabulario de partida doble en
DTOs salvo `credit`) pasan ahora que existen módulos reales que analizar
— confirmados uno por uno, no solo por el verde agregado de la suite.

### El hallazgo más caro de este loop — dos partes, una sola causa raíz

**Parte 1 — `$transaction()` en forma callback traga fallos diferidos
en silencio.** Con R1/R2/R4/R9 (`DEFERRABLE INITIALLY DEFERRED`), un
fallo en la forma callback (`prisma.$transaction(async (tx) => {...})`)
**no lanza excepción** — la promesa se resuelve limpio y la fila nunca se
comprometió. Verificado con un repro mínimo: `committed row exists? []`
después de una violación de R2 que debía tronar. Con la forma de arreglo
(`prisma.$transaction([...])`) sí lanza, pero esa forma no permite la
lógica condicional que `createWithEntries` necesita (`ON CONFLICT DO
NOTHING RETURNING`, y según haya fila o no, insertar entries o
re-seleccionar).

**Parte 2 — incluso con la forma de arreglo, el SQLSTATE se pierde
cuando el fallo ocurre en el `COMMIT`.** Un trigger diferido que falla en
el commit implícito llega como `PrismaClientUnknownRequestError` — sin
`code`, sin `meta`, verificado con `Object.getOwnPropertyNames` y
`util.inspect({showHidden:true})`. Solo queda el texto del `RAISE
EXCEPTION` en `.message`, sin el SQLSTATE en ningún lado accesible.

**La solución a ambas, encontrada por Luis, verificada empíricamente dos
veces (antes de implementar y de nuevo a petición suya):**
`SET CONSTRAINTS ALL IMMEDIATE` como **último statement dentro de la
transacción**, antes de que termine (sea forma de arreglo o forma
callback). Fuerza la evaluación de los constraints diferidos ahí mismo,
como un statement ordinario — el error sale como
`PrismaClientKnownRequestError` con `code: 'P2010'` y `meta.code` con el
`P10xx` real intacto, exactamente lo que `parsePgError` ya sabe leer. Y
de paso resuelve la Parte 1: con la forma callback, el fallo ahora sí se
propaga como excepción real, en vez de tragarse.

**Implementado en `PrismaTransactionRepository.createWithEntries()`**
(`src/shared/ledger/repositories/prisma-transaction.repository.ts`): usa
la forma callback (por la lógica condicional) con
`tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE')` como penúltimo
paso, justo antes del `SELECT` final de confirmación. Y en los cuatro
casos diferidos de T-Q07 (`errors.integration.spec.ts`), como último
elemento del arreglo.

**Corolario, encontrado al construir `createWithEntries`:** los métodos
TIPADOS de Prisma (`tx.entry.createMany`, `tx.budgetEntry.createMany`,
`.create()`, `.update()`...) tienen el MISMO problema que la Parte 2,
independientemente de si el trigger es diferido o inmediato — envuelven
CUALQUIER error no reconocido como `PrismaClientUnknownRequestError` sin
`code`/`meta`, aunque el SQLSTATE real sí viaje enterrado en el texto de
debug de Postgres (verificado forzando P1011 vía
`budgetEntry.createMany`). **Regla general para todo el loop 2:
cualquier escritura que pueda tocar un trigger custom (no una violación
`23505`/`23503`/`23514` que Prisma sí reconoce nativamente) tiene que
pasar por `$queryRaw`/`$executeRaw`, nunca por los métodos tipados del
Client.** `createWithEntries` quedó así: `$executeRaw` para el INSERT de
`transactions`, para cada `entry` y para cada `budget_entry` de
compensación — nada de `createMany`.

### Otros tres hallazgos del loop, más chicos

- **R8 es un trigger de base de datos, no una regla de Service —
  incondicional, sin importar la capa que emita el `UPDATE`.** Mi primer
  intento de T-OC02 asumía que "a nivel de repository se puede archivar
  con SQL directo, sin pasar por R8" — falso, nunca lo verifiqué antes de
  escribirlo, y el trigger lo bloqueó igual. Corregido financiando →
  drenando a cero → archivando (ahí sí con éxito) → financiando de nuevo
  por SQL directo (eso sí es alcanzable: S-R9 es una regla de ESTA capa,
  vive en el Service, no en un trigger de TASK-db).
- **R11 cubre `INSERT`, no solo `UPDATE`/`DELETE`** (ya lo sabíamos de
  TASK-db, pero volvió a morder aquí): T-H11 insertaba la asignación
  DESPUÉS de cerrar el periodo. Corregido a asignar mientras está abierto
  y cerrar después — es además el orden real en que pasaría.
- **Un comentario propio con la palabra "backoff" hizo fallar T-A10**
  (el grep de "sin reintento/sleep/backoff" en el código). El comentario
  decía "sin backoff" — el test no distingue código de comentario.
  Reescrito sin usar esa palabra literal.
- **`commitSetup`/`commitBalancedTransaction` (helpers locales de tres
  archivos de test) no hacían `ROLLBACK` antes de soltar la conexión al
  pool cuando `fn()` lanzaba.** Una conexión con una transacción abortada
  volvía al pool y el SIGUIENTE test que la tomara heredaba "current
  transaction is aborted" — un fallo en un test contaminaba a otro sin
  relación. Corregido en los tres archivos con `catch { ROLLBACK } finally { release() }`.

### Todo lo que quedó implementado

A00 (`DomainException`, 15 excepciones de dominio, `pg-error.ts` +
`prisma-error.mapper.ts`, `cursor.ts` + `cursor.dto.ts`,
`is-cents-string.validator.ts`, `ProfileInterceptor` + decoradores,
`code`/`timestamp`/`path` en `GlobalExceptionFilter`, `AuthModule` —
quedó sin construir al cerrar TASK-auth, hizo falta aquí),
A01 (`AccountsDataModule`), A02 (`QueriesModule`; `PeriodsDataModule`
diferido — ningún test de loop 1 lo necesita, `createWithEntries` recibe
las compensaciones ya resueltas), A03 (`LedgerModule` completo, las 7
funciones de `ITransactionRepository`), A04 (`profile`), A05
(`accounts`), A06 (`categories` + `income-sources`, dos controllers/dos
services compartiendo `AccountsDataModule`).

### Qué sigue

Loop 2 (A07–A11): grupos B/C/D/E/F/I/K/L/M/N/O/S + Grupo R contra
fixtures. Antes de arrancar, vale la pena que quien lo haga lea la
sección de `$transaction`/`SET CONSTRAINTS ALL IMMEDIATE` de arriba
completa — el cierre de periodo (grupo M) y las asignaciones con
`FOR UPDATE` (grupo L, T-L07) van a tocar exactamente esta misma clase de
problema.

## 2026-08-09 (3) — TASK-api.md, sesión de tests del loop 1 (A00–A06): suite completa escrita, sin implementación

```
npm run test:integration:api:core  → 7 suites, 4/5 en rojo, T-R10 en verde por diseño (ver nota)
npm run test:unit                  → 9 suites, 13/13 existentes ✅, 6 nuevas en rojo
npm run test:integration:db        → 14 suites, 123/123 ✅ (sin regresión)
npm run test:integration:auth      → 4 suites, 14/14 ✅ (sin regresión)
npm run test:integration:api       → suma exacta de :core (domain/ no existe aún, aporta 0)
```

### Alcance y dos huecos de la tabla §11.0 que el resumen de la sesión omitió

`TASK-api.md` §11.0 asigna **Grupo Q** (errores y mapeo) y **Grupo O-core**
(F1-F4 a nivel de repository) al loop 1; el prompt de la sesión no los
mencionó. Confirmado con Luis: los dos entran. **Grupo O-core no traía IDs
propios en el documento** — se agregó la sección completa a `TASK-api.md`
§11 (T-OC01–OC07), con los valores canónicos de `fn_unassigned_funds`
reusados tal cual de `ARCHITECTURE.md` §3.9 (740000n / 1140000n), nunca
recalculados.

### Archivos escritos

**Unitarios (`test:unit`, junto al código):**
`src/shared/ledger/{entry-builders,budget-compensations}.spec.ts`,
`src/common/pagination/cursor.spec.ts`,
`src/common/validators/is-cents-string.validator.spec.ts`,
`src/common/errors/{pg-error,prisma-error.mapper}.spec.ts`.
T-U24 se confirmó ya cubierto por T-I06 en `test/unit/next-due-on.spec.ts`
— no se creó archivo nuevo.

**Integración (`test/integration/api/core/`):**
`ledger-repository` (A-core), `queries-repository` (O-core),
`accounts` (G), `categories` (H), `profile` (P), `errors` (Q),
`contract-static` (R-core) — más `_helpers/{app,auth,seed}.ts`.

### Tres bugs de infraestructura encontrados y corregidos en esta sesión (no eran tests, eran configuración)

1. **`jest.config.js` nunca miraba `src/`** — `testMatch` solo tenía
   `test/**/*.spec.ts`. Los unitarios que `TASK-api.md` §14 pide junto al
   código eran invisibles para `test:unit` aunque existieran. Corregido a
   `['test/unit/**/*.spec.ts', 'src/**/*.spec.ts']` — acotado a
   `test/unit/` y no a todo `test/` para no chocar con
   `test/integration/`, que usa su propia config con `globalSetup`.
2. **El script `test:integration:db` sugerido por `TASK-api.md` §12
   rompe solo:** `--testPathIgnorePatterns` sin un `--testPathPattern`
   que lo acote deja pasar `test/unit/**` (el `testMatch` de
   `jest-integration.config.js` es amplio). Pasó de 123 a 136 tests
   reportados la primera vez que lo corrí. Corregido agregando
   `--testPathPattern="test/integration/"` de vuelta, además del ignore.
3. **`test:unit`** tenía `--testPathPattern=test/unit`, que excluye por
   substring cualquier ruta sin "test/unit" — es decir, excluía TODO
   `src/`. Cambiado a `jest` a secas, dejando que `testMatch` (ya
   corregido) haga todo el trabajo de scoping.

### Un hallazgo real durante la verificación, no un bug de test

**T-R06 reportó un falso positivo real** contra código ya aprobado: mi
primera versión escaneaba todo `src/`, y encontró `PrismaClient` en
`src/auth/services/ensure-profile-exists.service.ts` — que lo usa a
propósito, por mandato explícito de `TASK-auth.md` (`$queryRaw`, nunca
`prisma.profile.upsert()`). D1 ("un Service nunca importa PrismaClient")
es una regla nueva de esta capa, no retroactiva sobre `TASK-auth` ya
cerrada. Corregido acotando T-R06/T-R07/T-R08 a los 7 módulos de dominio
+ `src/shared/`, nunca a todo `src/`.

### Cosas que quedaron señaladas para que Luis decida, no resueltas por criterio propio

- **T-R10 pide `git status` de `prisma/migrations/` — este repo no tiene
  git inicializado.** Sustituto implementado: snapshot exacto de los 25
  nombres de carpeta de migración, comparado byte a byte. Detecta una
  migración nueva igual que `git status` lo haría, pero es una decisión
  de sustitución, no lo que el documento pide literalmente. Es, por
  diseño, **el único test de la suite que pasa en verde sin ninguna
  implementación** — no es un feature test, es un guardrail ("no crear
  migraciones") que ya es cierto hoy y debe seguir siéndolo.
- **T-R07 pide grep de `credit` en `src/**/dto/`, pero `TASK-api.md` §5.6
  lo prohíbe y lo declara como valor legítimo de `kind` en la misma
  sección** ("liability → credit", y `API-CONTRACT.md` lo muestra en sus
  propios ejemplos JSON). Grepearlo daría un falso positivo garantizado
  contra el contrato. T-R07 se implementó con los otros cinco términos
  (`entries`, `debit`, `asset`, `liability`, `equity`) y "credit" quedó
  fuera, documentado en el propio test.
- **T-G16 no se pudo escribir tal cual la pide `TASK-api.md`** ("cuenta
  archivada con saldo sigue contando en `GET /insights/account-balances`"):
  `/insights` es A10 (loop 2), y además R8 exige saldo EXACTO CERO para
  que `POST /accounts/{id}/archive` tenga éxito — un archivado por HTTP
  normal nunca puede terminar con saldo distinto de cero sin una reversa
  (A07, también loop 2). La garantía real de S-R4 se movió a **T-OC02**
  (repository, que sí puede archivar con SQL directo sin pasar por R8) y
  quedó con saldo −12345n antes/después. `accounts.integration.spec.ts`
  documenta la ausencia con un comentario en vez de un test vacío.

### Los tres señalados — resueltos con Luis en la misma sesión

- **T-R10** reemplazado por el equivalente sin git: conteo de carpetas de
  `prisma/migrations/` (25, fijo) + `prisma migrate status` corrido como
  subproceso real, confirmando `"Database schema is up to date!"`. Sigue
  siendo el único test que pasa sin implementación — es un guardrail, no
  un feature test.
- **T-R07 / "credit"**: gana el `kind` público (decisión de Luis) — ya
  está en `API-CONTRACT.md` con ejemplos JSON. El grep excluye `credit`
  y mantiene `debit` (jerga contable pura, sin uso legítimo). Nota
  agregada a `TASK-api.md` §5.6 explicando la contradicción original y
  su resolución.
- **T-G16 movido a Grupo O como T-O15**, reformulado con saldo **cero**
  (alcanzable por HTTP, R8 lo garantiza) en vez de saldo distinto de
  cero (estructuralmente inalcanzable — no solo por depender de
  `/insights`, loop 2, sino porque archivar exige saldo cero). Nota
  agregada a `TASK-api.md` bajo la tabla de Grupo G. La garantía con
  saldo real distinto de cero sigue en T-OC02, loop 1.

### Contenedor de Docker desapareció otra vez entre sesiones

Mismo patrón que en la sesión anterior — `docker ps -a` vacío al
arrancar. Se recreó, se aplicó el stub y `prisma migrate deploy`
reaplicó las 25 migraciones limpio. Empieza a ser un patrón recurrente
entre sesiones de este entorno, no un incidente aislado — vale la pena
que Luis decida si conviene un volumen persistente o un paso de arranque
documentado.

### Qué sigue

Loop 1 (A00–A06) tiene su suite completa y verificada en rojo. El
siguiente paso es el loop de implementación sobre esta misma suite —
condición de paro: los 6 comandos de `TASK-api.md` §0.1. El loop 2
(A07–A11, grupos B/C/D/E/F/I/K/L/M/N/O/S + Grupo R contra fixtures) no se
toca hasta que loop 1 cierre.

## 2026-08-09 (2) — Cerradas las dos piezas sin cobertura de tests (bigint override + refresh fn del MCP)

De los cuatro archivos que quedaron sin construir al cerrar `TASK-auth.md`
(ver entrada de abajo), Luis pidió cerrar los dos que son "lugares donde
un error pasa silencioso" — no bloqueaban la condición de paro, pero
tampoco tenían ningún test que los ejerciera.

```
npm run test:integration:auth  → 4 suites, 14/14 ✅ (sin cambio)
npm run test:unit              → 3 suites, 13/13 ✅ (sin cambio)
npm run test:integration:db    → 14 suites, 123/123 ✅ (sin cambio)
npx tsc --noEmit                → 0 errores en todo el repo
```

Los tres comandos de la condición de paro no se movieron — es lo
esperado: ningún test importa ninguno de los dos archivos nuevos. El
`tsc --noEmit` de todo el repo (`src` + `test` + `scripts`) es la única
verificación real de que compilan, ya que Jest nunca los toca.

- **`src/common/bootstrap/bigint-json-override.ts`** — reexporta (no
  duplica) el efecto secundario de
  `src/shared/money/bigint-serializer.ts`, ya probado en Grupo M. Lleva
  en el propio archivo la advertencia de por qué debe ser el primer
  import de `main.ts`, y la del gotcha de `TS2307` que no dispara con
  imports de solo efecto secundario (documentado abajo, en la entrada
  anterior) — para que quien lo borre o lo importe mal no dependa de leer
  `PROGRESS.md` para enterarse.
- **`mcp/auth/supabase-refresh-fn.ts`** — `createSupabaseRefreshFn`,
  agrega `@supabase/supabase-js` como dependencia real (no estaba
  instalada; es la única pieza del módulo que toca el SDK, por diseño).
  Verificado contra los `.d.ts` instalados: `Session.expires_in` es
  `number` obligatorio, `Session.expires_at` es `number` **opcional**
  (epoch segundos) — la conversión implementada prefiere `expires_at`
  cuando viene, y si no, deriva de `expires_in` + `Date.now()`, exacto a
  como lo especifica TASK-auth.md. El archivo deja escrito por qué esa
  conversión no la cubre ningún test (los tests #14-#16 inyectan una
  `RefreshFn` mockeada que ya entrega milisegundos) y cuál es el síntoma
  silencioso si el `* 1000` se pierde.

### Qué sigue sin construirse, y por qué

- **`src/auth/auth.module.ts`** y **`src/main.ts`** — quedan para cuando
  exista la app real corriendo (bootstrap completo, wiring de todos los
  providers/guards/filters en un módulo de Nest de verdad). Ningún test
  de la suite actual los necesita: `test/setup/auth/test-app.ts` arma su
  propio `TestingModule` aislado importando las piezas directamente, sin
  pasar por `AuthModule`. Construirlos ahora sería anticipar decisiones
  de la capa de aplicación (versión de Nest para el bootstrap real,
  puerto, middlewares globales, etc.) que no están en el alcance de
  `TASK-auth.md` ni tienen un test que las verifique — se hacen cuando
  arranque esa tarea, no antes.

## 2026-08-08/09 — TASK-auth.md: tests escritos y CERRADA (condición de paro en verde)

```
npm run test:integration:auth  → 4 suites, 14/14 ✅
npm run test:unit              → 3 suites, 13/13 ✅
npm run test:integration:db    → 14 suites, 123/123 ✅ (sin regresión)
npm run db:check-sync          → en sync, 8 modelos + 3 enums ✅
```

Confirmado también con `prisma migrate reset --force --skip-seed` desde
cero: las 25 migraciones (18 de `TASK-db` + `profiles` + `error_log` +
las intermedias) reaplican limpio, y las tres condiciones vuelven a salir
en verde después.

### La sesión tuvo dos partes: tests primero (revisados por Luis), loop de implementación después

1. **Tests (15 casos de la tabla de TASK-auth.md, más #14-#16 del MCP
   agregados después de que Luis cerró el contrato del refresh con otro
   chat).** Cuatro archivos en `test/integration/auth/` (auth-guard,
   profile-creation, validation-pipe, error-log-serializer) + un arnés
   HTTP de prueba mínimo (`test/setup/auth/test-app.ts`, dos endpoints:
   uno que devuelve `req.user.userId`, otro que lanza una excepción a
   propósito — a pedido explícito de Luis, "si crece es señal de que se
   está probando algo que pertenece a otro archivo"). Los tests #14-#16
   del MCP son unitarios (`test/unit/mcp-token-refresh.spec.ts`), no de
   integración — no tocan red ni DB.
2. **Loop de implementación**, siguiendo el grafo de dependencias de
   TASK-auth.md: `IAuthRepository` → `SupabaseAuthRepository` →
   `AuthGuard` → `ProfileDeletedException` + `EnsureProfileExistsService`
   → migración `error_log` → `ErrorLogRepository` (+
   `error-log-serializer.ts`) → `GlobalExceptionFilter` → módulo del MCP
   (rama independiente, al final). Un cambio por vuelta, `test:integration:db`
   verificado en 123/123 en cada una — nunca bajó.

### Hallazgo de entorno — el contenedor `db-test` desapareció entre sesiones

Al arrancar esta sesión, `docker ps -a` no mostraba ningún contenedor
(probablemente un reinicio de Docker Desktop entre conversaciones). Se
recreó con `docker compose up -d db-test` (queda una base vacía, nueva),
se aplicó el stub de auth a mano (`applyAuthStub()` vía `tsx -e`, sin
pasar por el `globalSetup` de Jest), y se corrió `prisma migrate deploy`
— truena la primera vez con `P3018` porque el stub debe aplicarse ANTES
de la migración de `profiles`. Se resolvió con
`prisma migrate resolve --rolled-back <profiles>` + reintentar deploy.
**Lección: si el contenedor de Docker se recrea desde cero fuera de
Jest, el orden manual es stub → resolve (si ya quedó una migración a
medias) → deploy — el `globalSetup` de Jest hace esto automáticamente,
pero solo cuando se invoca vía `npm run test:integration:*`.**

### Hallazgo de TypeScript — dos gotchas de NestJS + `emitDecoratorMetadata`, no documentados en ningún lado

1. **`import type` rompe la inyección de dependencias de Nest, en
   silencio.** `error-log.repository.ts` tenía
   `import type { PrismaClient } from '@prisma/client'` para el tipo del
   parámetro del constructor. `import type` borra el import en tiempo de
   compilación — sin el valor real de la clase, `emitDecoratorMetadata`
   no puede reflejar `design:paramtypes` correctamente y Nest ve
   `Function`/`Object` en vez de `PrismaClient`, y falla con "Nest can't
   resolve dependencies... argument Function at index [0]". Cualquier
   tipo usado SOLO como parámetro de constructor de una clase inyectada
   por Nest debe importarse como valor (`import { X }`), nunca como
   `import type { X }`, aunque en el archivo solo se use como anotación
   de tipo. Costó una vuelta completa diagnosticarlo — el mensaje de
   error de Nest no menciona `import type` en ningún lado.
2. **Un `import 'módulo-inexistente'` de solo efecto secundario NO genera
   `TS2307`**, a diferencia de un `import { X } from 'módulo-inexistente'`
   con bindings. Verificado con un repro aislado (`tsc` puro, sin Jest de
   por medio). Relevante para el patrón "rojo por diseño": un import de
   solo efecto secundario a un archivo de `src/` que no existe todavía
   NO va a fallar la compilación — solo un `require()` en runtime lo
   haría. Si se necesita ese patrón, hay que forzar un import con
   binding, aunque no se use el valor.

### `PrismaClient` en providers de NestJS: `useValue`, no `useClass`

El cliente generado no tiene `@Injectable()` (no es código nuestro) y su
constructor acepta un parámetro de opciones (`PrismaClientOptions`, una
interfaz — se borra en tiempo de ejecución). Si Nest intenta instanciarlo
él mismo (`useClass`/token implícito), intenta resolver ese parámetro por
DI y falla. Se registra como `{ provide: PrismaClient, useValue: new PrismaClient() }`
en el arnés de prueba — evita que Nest tenga que reflejar el constructor
del cliente generado en absoluto.

### Decisiones de forma que quedaron fijadas al implementar (eran inferencias en la fase de tests, ahora son código real)

- `EnsureProfileExistsService(prisma: PrismaClient)` con método
  `ensure(userId): Promise<ProfileRow>` — usa `$queryRaw` con template
  tag (parametrizado automáticamente por Prisma, nunca
  `$queryRawUnsafe`). Revisa `deleted_at` de la fila devuelta y lanza
  `ProfileDeletedException` sin reactivar nada.
- `error-log-serializer.ts` (`src/common/logging/`) **reexporta**
  `sanitizeMetadata` de `src/shared/money/bigint-serializer.ts` en vez de
  duplicarlo — es el mismo comportamiento que pide TASK-auth.md para
  `metadata` de ErrorLog, y de paso ese import transitivo es lo que
  registra el override de `BigInt.prototype.toJSON` antes de que
  `ErrorLogRepository.write()` serialice nada (nunca se necesitó un
  import explícito de `bigint-json-override.ts` en el arnés — quedó sin
  crear, ver huecos abajo).
- `ErrorLogRepository.write(entry): Promise<ErrorLog>` devuelve la fila
  insertada completa (con `RETURNING` implícito de `.create()`).
- `GlobalExceptionFilter`: `@Catch()` global, distingue `HttpException`
  (usa `getStatus()`/`getResponse()` tal cual) de cualquier otro throw
  (500 genérico, mensaje fijo, nunca el stack). Escribe en `ErrorLog`
  dentro de un `try/catch` que se traga cualquier fallo — best-effort de
  verdad, no en el nombre nada más.

### Migración nueva: `error_log`

`prisma/migrations/20260809020908_error_log/` — tabla `error_log`
(`message` NOT NULL, `stack`/`context`/`user_id`/`metadata` nullable,
`created_at`). Sin FK hacia `profiles`: una FK que pudiera violarse
volvería el logging de errores tan frágil como el error que intenta
registrar.

### Qué quedó sin construir (ningún test lo exige, entregables de TASK-auth.md que no se tocaron)

- `src/auth/auth.module.ts`, `src/main.ts`,
  `src/common/bootstrap/bigint-json-override.ts`,
  `mcp/auth/supabase-refresh-fn.ts`. Ninguno de los tests (los 4 de
  integración ni los 3 unitarios de MCP) los importa — la condición de
  paro de esta tarea es exactamente esos dos comandos, no "toda la lista
  de entregables". Si se quiere una app real corriendo (`main.ts` con el
  bootstrap completo), es trabajo aparte, no bloqueado por nada de lo de
  arriba.

## 2026-08-06 (7) — TASK-db.md CERRADA: las tres condiciones de paro en verde

```
npm run test:integration:db  → 14 suites, 123/123 ✅
npm run test:unit            → 2 suites, 10/10 ✅
npm run db:check-sync        → en sync, 7 modelos + 3 enums ✅
```

Confirmado también con un `migrate reset --force --skip-seed` desde cero
justo antes de este cierre: las 18 migraciones reaplican limpio en un
Postgres recién creado, y las tres condiciones vuelven a salir en verde
después. Es la validación de "el historial completo se reaplica desde
cero" que se perdió al descartar `migrate dev` — sigue cubierta.

### Lo resuelto por Luis en esta vuelta

1. **R11 se amplió a `BEFORE INSERT OR UPDATE OR DELETE`** (antes solo
   UPDATE/DELETE, fiel a la letra de `ARCHITECTURE.md` §3.4, pero eso
   dejaba sin cubrir el escenario de cierre desordenado que sí describe
   §3.10 y que T-N06 prueba). Migración nueva `04h_r11_covers_insert`
   (no se editó `04g`, ya aplicada — se creó una migración encima, como
   pide TASK-db.md §7.2).
2. **T-L03/T-L08 dejaron de depender de un conteo suelto ("12").**
   Ahora verifican una lista nominal de los 9 triggers reales — nombre,
   tabla, timing, eventos y qué regla implementa cada uno — declarada en
   `EXPECTED_TRIGGERS` dentro de `l-structure.spec.ts`. De paso quedó
   documentado el desglose que nunca existió: las 11 reglas (R1-R11)
   viven en 9 objetos físicos porque R1+R2+R4 comparten un trigger
   (`trg_entries_deferred_checks`, que también lleva la mitad de R9) y R9
   se completa con un segundo trigger propio en `transactions`
   (`trg_reversal_has_entries`). T-L08 de paso se arregló solo: el
   bitmask que usaba (`tgtype & 16`) comparaba UPDATE, no AFTER — ahora
   usa `information_schema.triggers.action_timing`.

   **Lista nominal exacta** (copiada de `EXPECTED_TRIGGERS` en
   `l-structure.spec.ts` — el test verifica esta misma tabla, no una
   paralela):

   | Trigger | Tabla | Timing | Eventos | Regla |
   |---|---|---|---|---|
   | `trg_entries_deferred_checks` | `entries` | AFTER | INSERT, UPDATE, DELETE | R1, R2, R4, R9 (lado entries) |
   | `trg_entries_owner_consistency` | `entries` | BEFORE | INSERT, UPDATE | R3 |
   | `trg_entries_immutable` | `entries` | BEFORE | UPDATE, DELETE | R5 |
   | `trg_transactions_immutable` | `transactions` | BEFORE | UPDATE, DELETE | R6 |
   | `trg_reversal_has_entries` | `transactions` | AFTER | INSERT | R9 (lado transactions) |
   | `trg_budget_entry_category_is_expense` | `budget_entries` | BEFORE | INSERT, UPDATE | R7 |
   | `trg_accounts_archive_requires_zero_balance` | `accounts` | BEFORE | UPDATE | R8 |
   | `trg_budget_period_dates_locked_when_closed` | `budget_periods` | BEFORE | UPDATE | R10 |
   | `trg_budget_entries_locked_when_period_closed` | `budget_entries` | BEFORE | INSERT, UPDATE, DELETE | R11 |

### Bugs míos, corregidos con autorización

- **T-M01**: creaba `Transaction` y un solo `Entry` con dos
  `prisma.*.create()` sueltos (dos commits separados) — violaba S-R1
  (`TASK-db.md` §3.4/U24: transaction+entries siempre en la misma
  transacción de DB) y disparaba R2 contra sí mismo. Envuelto en
  `prisma.$transaction([...])` con un segundo entry que balancea a cero.
- **T-G22**: encadenaba 4 llamadas a F1-F4 sin argumento dentro de la
  misma transacción esperando `42883` en cada una — la primera aborta la
  transacción y las siguientes reciben `25P02`, no su propio código
  (mismo mecanismo que documenta T-H04). Arreglado con `SAVEPOINT` +
  `ROLLBACK TO SAVEPOINT` entre cada intento.
- **T-D07** (sesión anterior): conteo global sin acotar, veía residuo de
  otros archivos. Acotado a los IDs del fixture.
- **T-D08 MXNN** (sesión anterior): `char(3)` rechaza un valor de 4
  caracteres antes de que el CHECK se evalúe. Separado en su propio caso
  esperando `22001`.

### Hallazgo de entorno — roles de Supabase no existen en Postgres local

Aplicar `06_rls` (policies `TO authenticated`) falló porque el rol
`authenticated` no existe en un Postgres plano — Supabase lo provisiona
por proyecto, a nivel de cluster. Mismo tipo de gap que `auth.users`.
Se agregó a `test/setup/local-auth-stub.sql` (no a una migración de
Prisma — son roles que Supabase ya trae en producción) un bloque
`DO $$ ... IF NOT EXISTS ...` que crea `authenticated`, `anon` y
`service_role` si no existen. Nunca corre contra Supabase real, igual
que el resto del archivo.

### Todo lo que quedó implementado (U01-U23, excepto lo explícitamente fuera de alcance)

18 migraciones, `prisma/schema.prisma` con 7 modelos + 3 enums, y los
tres archivos puros que sí entraban en el alcance de esta tarea aunque no
sean SQL: `src/shared/recurrence/next-due-on.ts` (U08b) y
`src/shared/money/{bigint-serializer,split}.ts` (U23). Ningún Service,
Controller ni Repository — eso sigue fuera, como dice TASK-db.md §1.

**`nextDueOn` — un ajuste al algoritmo, derivado de los propios tests,
no de una relectura literal de ARCHITECTURE.md.** El texto de §3.3 dice
"el mes calendario siguiente al de `last_confirmed_on`", que leído
literal siempre suma un mes. Pero T-I06 (confirmar el 1 de marzo un
recordatorio de día 31 → debe dar 31 de marzo, no abril) solo es posible
si el mes objetivo es el MISMO mes de `lastConfirmedOn` cuando el día
confirmado es menor que `dayOfMonth`, y el mes SIGUIENTE cuando es mayor
o igual. Verificado contra los 6 casos (T-I01-T-I06) uno por uno antes de
darlo por bueno — no quedó ninguna interpretación alternativa que los
satisfaga todos a la vez, así que no lo traté como una decisión abierta.

### Qué NO se implementó (fuera de alcance, documentado desde el principio)

- RLS semántico (solo desplegado, `TASK-db.md` §7 lo excluye de los tests).
- U24 (reglas de Service) — documental, sin migración, se transfiere al TASK de Services.
- Cualquier PENDIENTE de `ARCHITECTURE.md` §3.14 — no se topó ninguno directamente.
- Services/Controllers/Repositories/DTOs/endpoints.

## 2026-08-06 (6) — Vueltas 16-20 (R10+R11, F1-F4): 114/123 verdes. Detenido con 3 hallazgos.

**Quedó verde:** U15 `04g_closed_period_locks` (R10+R11 — los 25 tests de
Grupo E+F pasaron a la primera), U16 `05a_fn_account_balances` (F1),
U17 `05b_fn_category_balances` (F2), U18 `05c_fn_unassigned_funds` (F3 —
**los cuatro tests canónicos ⚠️ de Grupo G, T-G14/15/16/17, pasaron a la
primera corrida**, sin ajustar nada), U19 `05d_fn_transactions_without_period` (F4).

`test:integration:db`: **123 → 114 pasando, 9 en rojo.**

**Detenido antes de 06/07 — tres hallazgos, ninguno bloquea seguir con
RLS/seeds pero los dejo pendientes de tu palabra antes de tocarlos:**

1. **T-N06 — ¿R11 cubre INSERT?** `ARCHITECTURE.md` §3.4 define R11
   textualmente como `BEFORE UPDATE OR DELETE ON budget_entries` — nunca
   INSERT. T-N06 simula un cierre desordenado **insertando** un
   `budget_entry` nuevo en un periodo ya cerrado, esperando `P1011`. Con
   R11 implementado exactamente como lo especifica `ARCHITECTURE.md`, ese
   INSERT no dispara nada — pasa sin error. Misma clase de contradicción
   que T-D08 (dos documentos, no compatibles en este punto).

2. **T-L03 — no llego a "12 triggers".** Implementé 9 triggers,
   siguiendo al pie de la letra cada disparo que `ARCHITECTURE.md`
   especifica explícitamente (U09: "un solo trigger" para R1+R2+R4;
   U12/R9: "dos triggers"; el resto, uno por regla salvo que compartan
   función). Cada regla individual está probada y pasa — el conteo
   agregado es lo único que no cuadra. No encontré ninguna
   combinación de "un trigger por regla vs. combinados" documentada que
   sume exactamente 12 sin inventar una división no especificada en
   ningún lado (ej. partir R5/R6/R10 en un trigger de UPDATE y otro de
   DELETE cada uno, que ARCHITECTURE.md no pide).

3. **T-L08 — bug mío, no de diseño.** El query compara `t.tgtype & 16`
   pensando que era el bit de "AFTER" — es el bit de UPDATE. Por eso no
   encuentra `trg_reversal_has_entries` (que es AFTER INSERT, no AFTER
   UPDATE). Se arregla usando `information_schema.triggers.action_timing`
   en vez de manipular el bitmask a mano. Pido autorización antes de
   tocarlo, como con cualquier test.

4. **T-M01 — bug mío, no de diseño.** Crea la `Transaction` y UN solo
   `Entry` con dos llamadas separadas a `prisma.*.create()` — cada una
   hace su propio commit implícito. La segunda llamada (el entry, solo)
   dispara R2 correctamente (`P1002`, exactamente un entry) — el trigger
   está bien, el test viola su propia regla S-R1 de `TASK-db.md` §3.4
   ("transaction + entries siempre en la misma transacción de DB"). Se
   arregla envolviendo ambos `.create()` en `prisma.$transaction([...])`
   y agregando un segundo entry que balancee a cero. Pido autorización.

## 2026-08-06 (5b) — Resuelto por Luis, loop retomado

- **T-D07**: autorizado acotar el conteo a los dos IDs del fixture
  (`a.accounts.nu`, `b.accounts.nu`) en vez de un conteo global. Aplicado.
- **T-D08 (MXNN)**: confirmado que gana `ARCHITECTURE.md` (`char(3)`,
  fuente de verdad declarada por `TASK-db.md`). Separado el `it.each` en
  dos: `mxn`/`MX` siguen esperando `23514`; `MXNN` ahora espera `22001`
  explícitamente, con el porqué documentado inline.
- 16/16 de Grupo D en verde. `test:integration:db`: **78 pasando, 45 en
  rojo** (de 76 antes de estos dos fixes).

## 2026-08-06 (5) — Loop detenido en vuelta 15: dos hallazgos que requieren decisión

**Quedó verde desde la última entrada:** U07 `02e_budget_entries`,
U08a `02f_recurring_templates`, U10 `04b_entries_owner_consistency` (R3),
U11 `04c_ledger_immutability` (R5+R6), U12 `04d_reversal_magnitude` (R9,
dos triggers), U13 `04e_budget_entry_category` (R7), U14
`04f_archive_zero_balance` (R8). `db:check-sync` en verde en todas.
`test:integration:db`: **123 → 76 pasando, 47 en rojo** (de 46 en la
entrada anterior a 76 — progreso real y consistente vuelta a vuelta).

R9 (dos disparos) funcionó a la primera: 11/12 tests de Grupo C pasaron
en la primera corrida (el único que falló, T-C07, necesita F1, que
todavía no existe — no es un bug de R9).

**Detenido en vuelta 15 (`04f_archive_zero_balance`, R8) — dos hallazgos,
ninguno es un bug de la migración que acabo de escribir:**

**1. T-D07 — bug real en el test, no en la migración.** Hace un conteo
GLOBAL sin acotar (`SELECT count(*) FROM accounts WHERE lower(name) =
'nu'`), esperando `2`. Bajo `withRollback` aislado pasa, pero corriendo
la suite completa (`npm run test:integration:db`, el comando real de la
condición de paro) da `4` — porque `a-balance-zero.spec.ts` y
`c-immutability-reversal.spec.ts` corren antes (alfabéticamente) y usan
`truncateAll` + commits reales en su `beforeEach`; la última tanda de
cada uno deja residuo comprometido en la base (una fila "Nu" por
usuario) que nadie vuelve a limpiar antes de que corra `d-accounts.spec.ts`.
El conteo sin acotar por ID lo recoge. **No edité el test** — regla del
loop. Reproducido con el comando real de la condición de paro, no solo
en aislado.

**2. T-D08 (caso `MXNN`) — contradicción entre `ARCHITECTURE.md` y
`TASK-db.md`, no algo que yo deba resolver.** `ARCHITECTURE.md` §3.3
declara `currency char(3)` explícitamente. Con ese tipo, un valor de 4
caracteres (`'MXNN'`) lo rechaza **Postgres mismo** con `22001 value too
long for type character(3)`, antes de que el `CHECK
accounts_currency_format` (que da `23514`) llegue a evaluarse. `mxn` (3
caracteres) y `MX` (se rellena a `'MX '`) sí llegan al `CHECK` y dan
`23514` correctamente — ambos pasan. Pero `TASK-db.md` (T-D08) espera
`23514` **en los tres casos**, algo estructuralmente imposible con
`char(3)` para el caso de longitud excedida. Implementé exactamente lo
que `ARCHITECTURE.md` especifica; el test refleja exactamente lo que
`TASK-db.md` especifica; los dos documentos no son compatibles en este
punto.

**No elegí por mi cuenta.** Ambos son exactamente el tipo de "detente y
pregunta" que piden `CLAUDE.md` y `TASK-db.md` §7.5 — un test que parece
mal (T-D07) y una contradicción entre dos documentos (T-D08). Se lo
reporté a Luis con las dos opciones que veo para cada uno, sin aplicar
ninguna.

## 2026-08-06 (4) — Loop de implementación, vueltas 1-8 (U01-U09)

**Arrancó el loop de `TASK-db.md`.** Condición de paro: `test:integration:db`
+ `test:unit` + `db:check-sync`, corridos por separado. Flujo de cada
vuelta: carpeta de migración a mano (timestamp UTC) → `.sql` completo →
reflejar en `schema.prisma` → `migrate deploy` → `db:check-sync`.

**Quedó verde:**
- U01 `00_extensions`, U02 `01_enums`, U03 `02a_accounts`,
  U04 `02b_budget_periods` + U04(cont.) `03_period_exclusion`,
  U05 `02c_transactions`, U06 `02d_entries`, U09 `04a_entries_deferred_checks` (R1+R2+R4).
- `db:check-sync` extendido para validar también `enum` (no solo
  `model`/tablas) — comparado contra `pg_enum`/`pg_type`, mismo enfoque sin
  tooling de Prisma que ya usa para tablas.
- Conteo de `test:integration:db`: **123 → 46 pasando, 77 en rojo**
  (progreso real vuelta a vuelta, verificado en cada una — nunca se quedó
  plano tres vueltas seguidas).

**Bug real encontrado y corregido en la misma vuelta (U09):** el orden de
checks en `fn_entries_deferred_checks()` importaba. Con R1 (suma-cero)
evaluado antes que R2 (mínimo dos entries), un solo entry desbalanceado
—que siempre lo está, `entries_amount_nonzero` ya prohíbe el monto
0— disparaba `P1001` genérico en vez de `P1002` específico (T-A06 lo
detectó). `ARCHITECTURE.md` §3.4 ya lo advierte para R2: "Validarlo
explícitamente da un mensaje claro en vez de uno confuso desde R1."
Corregido invirtiendo el orden (R2 antes que R1) dentro de la misma
migración — no se creó una migración nueva porque todavía no se había
cerrado la vuelta ni nada dependía de ella; se corrigió el `.sql` y se
reconstruyó con `migrate reset` (que de paso volvió a confirmar que el
historial completo se reaplica limpio, la validación que reemplaza a la
shadow database de `migrate dev`).

**Confirmado con el trigger diferido real: T-A08 pasa.** Es el
discriminante de diferimiento (inserta un entry desbalanceado sin COMMIT,
no debe lanzar; balancea y hace COMMIT, debe pasar). Los tests de R1/R2/R4
estaban bien escritos — el diferimiento funciona tal como TASK-db.md §5.1
lo describe.

**Sigue rojo, por qué (esperado, no bugs):**
- T-A01/T-A02 (Grupo A) fallan porque `fn_account_balances` (F1, U16) no
  existe todavía — vienen después en el grafo.
- T-A09 (R5) falla porque la inmutabilidad (U11, `04c`) no está
  implementada todavía — el `DELETE` de un entry hoy simplemente
  funciona, sin bloqueo.
- El resto de los 77 en rojo son, en su mayoría, la misma historia:
  unidades más adelante en el grafo (F1-F4, R3, R5-R11, seeds) que
  todavía no llegan.

**Confirmado con Luis que las firmas de F2/F3/F4 en `ARCHITECTURE.md`
§3.9 (ya formalizadas por el chat de la DB) coinciden exactamente con los
nombres que los tests ya asumían** — cero tests que ajustar antes de
implementar esas funciones.

**Siguiente vuelta:** `04b_entries_owner_consistency` (R3), después
`04c_ledger_immutability` (R5+R6, va a resolver T-A09).

## 2026-08-06 (3) — Flujo de migraciones cerrado: `migrate deploy` único mecanismo

**Decisión de Luis, formalizada:** opción 1 — `migrate deploy` como único
mecanismo de aplicación de aquí en adelante. `migrate dev` (con o sin
`--create-only`) queda prohibido, en `CLAUDE.md` (Reglas duras) y
`TASK-db.md` (§3, §7.2), junto a `db push`.

**La opción 2 (meter `auth.users` en las migraciones de Prisma) se
descartó con una razón más fuerte de la que yo había planteado:** no es
solo "revierte una decisión ya cerrada" — obligaría a correr
`CREATE TABLE auth.users` como migración versionada contra Supabase real,
donde esa tabla ya es de Supabase. `IF NOT EXISTS` lo haría inocuo, pero
sigue siendo versionar DDL sobre un schema que no controlamos.

**Se intentó automatizar la verificación de sync de `schema.prisma` con
herramientas de Prisma y se encontró una SEGUNDA regresión grave, peor
que la primera:**

1. `migrate diff --to-url` (comparar `schema.prisma` contra la base viva,
   sin reaplicar historial) sí evita el problema de la shadow database —
   pero igual exige `multiSchema` + `schemas=["public","auth"]` para
   tolerar la FK cruzada `profiles → auth.users` (si no, `P4002`).
2. **Con `multiSchema` activo, `prisma migrate reset` también borra
   `auth.users`** — no es exclusivo de la shadow database de
   `migrate dev`. Verificado rompiendo el reset en vivo: `migrate reset`
   aplicó la migración de `profiles` y falló con `P3018` /
   `relation "auth.users" does not exist`, porque el propio reset había
   borrado `auth.users` como parte de "limpiar los schemas que gestiona".
3. **Recuperado de inmediato**: reaplicado el stub a `db-test`, revertido
   `schema.prisma` a la versión sin `multiSchema`, confirmado
   `migrate reset` sano otra vez (aplica `profiles` limpio, sin errores).
   `db-test` no quedó en ningún momento en un estado que sobreviviera la
   sesión — se verificó healthy al final.

**Conclusión: ninguna herramienta de diff de Prisma es segura de usar
mientras `auth.users` viva fuera de sus migraciones.** Se construyó
`scripts/check-schema-sync.ts` (`npm run db:check-sync`) que NO usa nada
de Prisma para esto — parsea `schema.prisma` con una expresión regular
simple y compara contra `information_schema.columns` leído con `pg`
directo. Probado con caso positivo (sync real → `[OK]`, exit 0) y caso
negativo (columna inventada inyectada a mano → `[DRIFT]`, exit 1, luego
revertida). Solo compara el schema `public`, nunca `auth`.

**Limpieza:** `db-shadow` borrado de `docker-compose.yml` (contenedor
detenido y eliminado), `SHADOW_DATABASE_URL` borrado de `.env`.

**Confirmado — T-L03 sigue cubriendo lo que se pierde al no usar
`migrate dev`:** su precondición documentada (`migrate reset` +
`migrate deploy` sobre contenedor limpio) es la misma validación de
"el historial completo se reaplica desde cero" que daba la shadow
database de `migrate dev`, solo que como test dentro de la suite en vez
de como paso previo del comando. `/verify` ya la ejecuta en sus pasos
2–3, antes de correr la suite.

**Estado final verificado:** `prisma validate` limpio, `migrate status`
sin drift, `db-test` con `profiles` y `auth.users` intactos,
`npm run db:check-sync` en verde. Nada de `TASK-db.md` implementado más
allá de la migración de `profiles` — sigue siendo el único cambio de
esquema en el repo.

## 2026-08-06 (2) — `shadowDatabaseUrl` probado y descartado

**Contexto:** siguiendo la recomendación de Luis, se intentó configurar
`shadowDatabaseUrl` (con `db-shadow` en Docker + stub de auth pre-aplicado)
para no perder la validación de drift de `prisma migrate dev`. Se pidió
explícitamente verificar el comportamiento del schema `auth` en la shadow
database antes de darlo por bueno — mismo tipo de trampa que ya había
costado una vuelta con `migrate reset`.

**Resultado: no funciona, y el hallazgo es más grave de lo esperado.**
Detalle completo, paso a paso, en `TASK-auth.md` → "`shadowDatabaseUrl`:
probado y descartado". Resumen:

1. Con `shadowDatabaseUrl` + `multiSchema` configurados: `migrate dev`
   falla porque Prisma borra `auth.users` (no el schema, la tabla)
   **dentro de su propia ejecución**, al preparar la shadow database.
2. Reaplicar el stub a la shadow DB inmediatamente antes de correr el
   comando **no ayuda** — el borrado ocurre adentro del mismo proceso de
   `migrate dev`, no hay ventana externa para reinyectarlo a tiempo.
3. **Hallazgo no buscado, más grave:** al revertir la config y confirmar
   que el flujo anterior (`--create-only` + `deploy`) seguía sano, se
   descubrió que **`--create-only` también depende de una shadow database
   en cuanto existe más de una migración en el historial** — usa una
   efímera autogenerada si no hay `shadowDatabaseUrl` explícito. Mismo
   error (`P3006`). No hay flag para desactivarlo.

**Conclusión:** mientras `auth.users` viva fuera de las migraciones de
Prisma (decisión ya cerrada en `TASK-auth.md`), **ningún `prisma migrate
dev` — con o sin `--create-only` — va a funcionar desde la segunda
migración del proyecto en adelante.** `prisma migrate deploy` es el único
comando verificado que aplica sin usar shadow database (confirmado dos
veces, con la migración de `profiles` y en este experimento).

**Revertido a estado sano:** `schema.prisma` quedó sin `shadowDatabaseUrl`
ni `multiSchema` (el estado que sí funcionaba). `docker-compose.yml`
conserva el servicio `db-shadow` y `.env` conserva `SHADOW_DATABASE_URL`,
ambos marcados como no conectados a nada por ahora, no borrados, por si
una decisión futura los retoma. Verificado después de revertir:
`prisma validate` y `prisma migrate status` limpios, `db-test` intacto
(`profiles` sigue ahí, sin tocar).

**Decisión pendiente, ahora más urgente — bloquea la SEGUNDA migración de
`TASK-db` (probablemente `00_extensions`), no solo casos con FK a auth:**
1. Adoptar `migrate deploy` como único mecanismo de aplicación de aquí en
   adelante (los `.sql` se escriben a mano en
   `prisma/migrations/<timestamp>_<nombre>/`, sin `--create-only`). Se
   pierde la validación de drift de `migrate dev` en cada vuelta del loop;
   el paso 3 de `/verify` (`migrate status`) la sigue cubriendo, después
   de aplicar en vez de antes.
2. Revertir la decisión "`auth` fuera de las migraciones de Prisma" — no
   es algo que se decida solo, contradice un cierre explícito de
   `TASK-auth.md`.

**Corrección al número de la sesión anterior, como pidió Luis:** el
semáforo de referencia para `test:integration:db` es **123 tests, 0 en
verde** (no 122 — ver la entrada de abajo, "2026-08-06 — Migración de
`profiles` aplicada", donde se explica el porqué del salto).

## 2026-08-06 — Migración de `profiles` aplicada (TASK-auth, un solo cambio)

**Qué quedó verde:** la migración `20260806003906_profiles` — tabla
`public.profiles`, FK `RESTRICT` a `auth.users.id`, sin trigger de
`updated_at`, índice parcial `idx_profiles_active`, RLS activo con
`profiles_select_own`/`profiles_update_own`, sin policy de INSERT/DELETE.
Verificado en psql contra el contenedor real: columnas, tipos, defaults,
el FK, el índice, `rowsecurity = t` y las dos policies, todo coincide
exactamente con el SQL dado. `model Profile` agregado a
`prisma/schema.prisma` (sin relación a `auth.users` — esa tabla no es un
modelo de Prisma). `npx prisma migrate status` → "Database schema is up
to date!", sin drift.

El SQL de la migración y el porqué de cada decisión (RESTRICT, sin
trigger, sin policy de INSERT/DELETE) ahora vive también en
`TASK-auth.md`, sección "Migración de `profiles`" — ya no depende de que
alguien la pegue por separado.

**Qué sigue rojo y por qué:** `test:integration:db` sigue en rojo — ahora
**123** tests (antes 122; ver hallazgo abajo), fallando por
`relation "accounts" does not exist`. Es el bloqueo correcto: `profiles`
ya existe, el fixture avanza hasta el primer `insertAccount` y truena ahí
porque `02a_accounts` (TASK-db, U03) todavía no está implementada — nada
más se tocó en esta sesión, como se pidió explícitamente ("solo esa
migración, nada más").

**Trampa de entorno que no estaba documentada — shadow database de
`prisma migrate dev`:** aplicar la migración con el flujo estándar
(`prisma migrate dev --create-only` → editar → `prisma migrate dev`) falla
en el último paso con `P3006: schema "auth" does not exist`. Causa: `migrate
dev` (sin `--create-only`) valida contra una **shadow database** que crea y
destruye reaplicando todo el historial de migraciones desde cero — esa
base nunca tiene el stub de `auth.users` (no es una migración de Prisma).
Cualquier migración que referencie `auth.users`/`auth.uid()` va a chocar
con esto siempre, no solo esta vez. Workaround usado: `migrate dev
--create-only` (no toca la shadow DB) + `prisma migrate deploy` para
aplicar (tampoco usa shadow DB). Detalle completo, con las dos salidas
posibles sin decidir todavía, en `TASK-auth.md` § "Migración de
`profiles`" — **hace falta que alguien decida esto antes de que el loop
de `TASK-db` cree su primera migración**, porque le va a pasar lo mismo
en cuanto cualquier tabla llegue a necesitar `profiles` (que es
inmediato, desde `02a_accounts`).

**Otro hallazgo, efecto colateral esperado pero no obvio:** `m-bigint.spec.ts`
(T-M01) pasó de "Test suite failed to run" (`@prisma/client did not
initialize yet`, 0 tests contados) a correr de verdad (1 test, en rojo
por razón real) — por eso el conteo total subió de 122 a 123. Antes de
esta migración, el cliente de Prisma generado no tenía ningún modelo real
y el constructor de `PrismaClient` tronaba. Con `model Profile` agregado
y `prisma generate` corrido, el cliente ya es real y T-M01 empieza a
ejercer código de verdad. Es progreso, no una regresión — pero vale la
pena que quien corra `verify:coverage` sepa que el número total de tests
activos va a seguir subiendo así, no solo cuando se implementen
migraciones de `TASK-db`.

## 2026-08-05 — Integración del stub de auth local (TASK-auth aplicado, sin implementar TASK-db)

**Contexto:** se copiaron al repo los artefactos de `TASK-auth` para bootstrap
de `auth.users` en Postgres local: `test/setup/local-auth-stub.sql`,
`test/jest-integration.config.js`, `test/setup/apply-auth-stub.ts`,
`test/setup/global-setup.ts`. Las correcciones 1 (`rootDir`) y 2
(`maxWorkers` en vez de `runInBand` en config) ya venían aplicadas. Esta
sesión resolvió las correcciones 3, 4 y 5, con verificación empírica.

**Bootstrap nuevo necesario para poder probar cualquiera de esto:**
`prisma/schema.prisma` (solo `datasource`+`generator`, **cero modelos** —
no implementa nada de `TASK-db.md`) y `.env` con `DATABASE_URL`/`DIRECT_URL`
apuntando al Postgres local (mismo valor que `TEST_DATABASE_URL`), porque
no hay credenciales reales de Supabase en este entorno.

**Corrección 3 — flag de `testPathPattern`, verificado empíricamente:**
Jest instalado es `29.7.0` (`package.json` fija `^29.7.0`). En esa
versión el flag correcto es `--testPathPattern` (singular) — el que ya
tenían mis scripts. Verificación empírica (no por changelog):

```
--testPathPattern="test/integration/auth/"   → 0 matches (correcto: auth/ no existe aún)
--testPathPatterns="test/integration/auth/"  → Jest 29 NO reconoce el flag,
                                                lo ignora en silencio y
                                                lista LAS 16 SUITES COMPLETAS
                                                (14 de integración + 2 unit)
```

Confirma exactamente el riesgo que describía la corrección: el flag
equivocado no falla, corre todo. Con el flag correcto verifiqué también
que un patrón con negative lookahead (`test/integration/(?!auth/)`)
excluye `auth/` de verdad — creé un `test/integration/auth/tmp-verify.spec.ts`
de prueba, confirmé que `:auth` lo encontraba y `:db` no, y lo borré.

**Scripts nuevos en `package.json`** (los tres que menciona el comentario
de `global-setup.ts`): `test:integration` (todo, config nuevo),
`test:integration:auth` (`test/integration/auth/`),
`test:integration:db` (`test/integration/(?!auth/)`, regex con negative
lookahead, entre comillas simples para que el shell no interprete `()`/`!`).
`scripts/check-test-coverage.ts` también se actualizó para usar
`--config test/jest-integration.config.js` — sin esto, una vez que el
fixture inserta en `auth.users` primero, el script hubiera fallado por
"relation auth.users does not exist" en vez de reportar la cobertura real.

**Corrección 4 — ¿`migrate reset` borra el schema `auth`? Verificado empíricamente:**

```
1. applyAuthStub() → auth.users creada, auth.uid() responde NULL. Confirmado con \dn + \dt auth.*
2. npx prisma migrate reset --force --skip-seed → "Database reset successful"
   (el paso de `generate` posterior falla porque el schema no tiene modelos
   todavía — esperado, no es el objeto de esta prueba)
3. \dn + \dt auth.* de nuevo → auth.users SIGUE AHÍ
```

**Resultado: el schema `auth` sobrevive.** `prisma migrate reset` solo
resetea el schema `public` (su `owner` cambió de `postgres` a
`pg_database_owner` y de vuelta a `postgres` entre corridas — señal de
que se recreó — mientras que `auth` mantuvo su owner sin tocar). Conclusión
de la corrección: **`globalSetup` es suficiente, no hace falta que T-L03
ni ningún otro test vuelva a invocar el stub.** El diseño reutilizable de
`apply-auth-stub.ts` (función exportada e idempotente) ya estaba bien
hecho desde que llegó — se queda así por si el comportamiento cambia con
otra versión de Postgres/Prisma, pero hoy no hace falta invocarlo dos veces.

**Corrección 5 — `fixture.ts` y usos directos de `profiles`:**
`insertProfile` ahora inserta primero en `auth.users (id)`, luego en
`profiles (id)`. Encontré **dos usos directos de `INSERT INTO profiles`
que no pasaban por `fixture.ts`** y que se hubieran roto igual:
`test/integration/k-seeds.spec.ts` (`newSeededUser` y el setup inline de
T-K03) — factorizados a un helper local con el mismo orden.

**Hallazgo no pedido, pero relacionado:** `truncateAll()` (usado por
a-balance-zero, c-immutability-reversal, h-idempotency para limpiar entre
tests) truncaba `profiles`. Con `auth.users` como padre real de la cadena
de FKs, truncar `profiles` deja filas huérfanas acumulándose en
`auth.users` entre tests (no rompe nada, pero crece sin límite). Cambiado
a truncar `auth.users` — el `CASCADE` llega a `profiles` y de ahí a las
seis tablas igual.

**Resultado de `npm run test:integration:db` tras todos los cambios:**

```
Test Suites: 14 failed, 14 total
Tests:       122 failed, 122 total
```

**122/122, cero verdes — el número no cambió.** La razón de fallo en los
tests que usan el fixture pasó de `relation "auth.users" does not exist`
(si el stub no se hubiera aplicado) a `relation "profiles" does not
exist` — confirma que el INSERT en `auth.users` ahora funciona y el
siguiente bloqueo real (falta `profiles`, sigue sin implementar) es el
correcto. `test:integration:auth` corre limpio con 0 tests (no hay specs
de auth todavía — sale con código 1 "No tests found", es el comportamiento
normal de Jest hasta que exista al menos un test ahí). `test:unit` y
`verify:coverage` no cambiaron (122 tests, 129/129 IDs, 0 MISSING).

**⚠️ Riesgo encontrado, no resuelto — para que Luis decida:**
El paso 2 de `/verify` (`.claude/skills/verify/SKILL.md`) corre
`npx prisma migrate reset --force --skip-seed` **sin ningún `-e .env.test`
ni flag de entorno**. Eso significa que Prisma resuelve `DATABASE_URL`
desde el `.env` de la raíz (auto-cargado por el propio CLI de Prisma,
independiente de `dotenv-cli`). Hoy funciona porque yo puse el `.env` de
esta sesión a apuntar al Postgres local — pero el día que se reemplace
`.env` con las credenciales reales de Supabase (TASK-db.md §10, paso 7,
acción humana), **correr `/verify` (o `db:reset:test`) resetearía Supabase
de producción**, no el contenedor de tests. Ninguno de los scripts actuales
scopea el reset explícitamente a `TEST_DATABASE_URL`. No lo toqué porque
es una decisión de diseño del flujo de entorno (¿el skill debería forzar
`-e .env.test`? ¿debería usarse una variable separada para "dev local" vs
"producción"?), no un bug de este setup de tests. **Detente y decide esto
antes de que `.env` tenga credenciales reales.**

## 2026-08-03 (2) — Reconciliación de baseline (Docker real, sin implementación)

**Contexto:** Luis corrió la suite contra Docker de verdad (sin nada
implementado) y encontró 3 discrepancias contra el reporte anterior.
Diagnóstico de cada una, con Docker corriendo (`presupuestos-db-test-1`,
healthy):

**1. Dos tests pasaban contra una base vacía — eran falsos positivos reales.**
- `T-L06` (`l-structure.spec.ts`): solo afirmaba "F1-F4 no son vistas"
  (`pg_views` sin filas) — vacuamente cierto si nada existe. Se le agregó
  la afirmación positiva de que las 4 funciones SÍ existen en `pg_proc`
  antes de verificar que no son vistas.
- `T-J03` (`j-soft-delete.spec.ts`): solo afirmaba "no existe `deleted_at`
  en `transactions`/`entries`" — igual de vacuo sin las tablas. Se le
  agregó la afirmación de que las columnas reales (`entries.amount_cents`,
  `transactions.booked_at`) sí existen primero.
- Re-corrida toda la suite de integración tras el fix: **0 tests pasan**
  contra la base vacía (antes: 2). Verificado empíricamente, no solo por
  revisión de código — es la única forma confiable de detectar este tipo
  de falso positivo.
- **No eran** los `withRollback` de `a-balance-zero.spec.ts:161,207` que
  Luis sospechaba (T-A07, T-A09) — esos SÍ fallan correctamente (la
  sospecha era razonable pero la causa estaba en otro lado).

**2. 129 IDs "cubiertos" ≠ 129 tests que Jest ejecuta — eran medidas distintas, no un bug de cobertura real.**
El diff anterior (`grep -o | sort -u`) contaba **menciones únicas de ID en
texto fuente**, no **casos de test que Jest registra**. Tres efectos
distintos se mezclaban en la diferencia 129→122:
- `it.each` hace que un ID (T-D08, T-I07, T-I08) corra **más de una vez**
  (+4 tests reales sobre las 3 IDs).
- Dos suites (`test/unit/*.spec.ts`, 9 IDs) no cargan todavía porque
  `src/shared/**` no existe — **por diseño**, no se implementó código en
  la sesión anterior. Jest reporta "Test Suites: failed" pero **0 tests**
  para esas suites (un error de compilación impide que Jest llegue a
  registrar los `it()` individuales).
- `m-bigint.spec.ts` (T-M01) truena al construir `PrismaClient` (antes de
  cualquier `it()`) — mismo efecto: 0 tests contados para esa suite.
- Con `test:integration && test:unit` (el comando exacto de §0 de
  `TASK-db.md`), el `&&` corta la ejecución en cuanto `test:integration`
  sale con código ≠ 0 (que va a pasar siempre hasta que haya
  implementación) — **`test:unit` nunca llega a correr**. No es un bug de
  los tests, es un efecto del encadenamiento con `&&` mientras la
  integración esté en rojo. Vale la pena que lo tengas presente: mientras
  dure la implementación, una regresión en los tests unitarios sería
  invisible si solo se mira la salida de ese comando encadenado.

Se construyó `scripts/check-test-coverage.ts` (`npm run verify:coverage`)
para reemplazar el diff ad hoc: corre Jest con `--json`, cuenta IDs
**contra resultados reales** de Jest (no contra texto), y separa en
`RAN_PASS` / `RAN_FAIL` / `SUITE_CRASHED` (el archivo existe pero no
cargó) / `MISSING` (no hay ningún `it()` con ese ID en ningún archivo).
Solo `MISSING` bloquea (exit 1). Resultado actual:

```
Esperados: 129 (128 en .spec.ts + T-L04 en scripts/db-parity-check.ts)
  RAN_PASS:      0
  RAN_FAIL:    118
  SUITE_CRASHED: 10  (los 9 IDs de test/unit + T-M01)
  MISSING:       0
```

**3. Auditoría completa de `withRollback` contra R1/R2/R4/R9 (P1001/P1002/P1004/P1009).**
Se grepeó cada assert de esos 4 ERRCODEs en todo `test/`: los 6 casos
(T-A03, T-A04, T-A06, T-A10, T-C09, T-C11) usan `expectDeferredRejection`
(commit real), ninguno usa `withRollback`. Los usos de `withRollback` que
sí aparecen en `a-balance-zero.spec.ts` (T-A07: CHECK; T-A09: R5) y en
`c-immutability-reversal.spec.ts` (R5/R6, y los `23505`/`23514`
inmediatos de T-C10/T-C12) son legítimos — ambos son reglas inmediatas,
no las 4 diferidas. Se agregó el comentario que faltaba en
`a-balance-zero.spec.ts` (encabezado + inline en T-A07/T-A09),
consistente con el que ya tenía `c-immutability-reversal.spec.ts`.

**Archivos tocados en esta sesión:** `test/integration/l-structure.spec.ts`,
`test/integration/j-soft-delete.spec.ts`, `test/integration/a-balance-zero.spec.ts`,
`scripts/check-test-coverage.ts` (nuevo), `package.json` (script `verify:coverage`).
**No se tocó** ninguna migración, trigger, función ni `schema.prisma` —
sigue siendo solo tests + tooling de verificación.

**Baseline confirmado tras los fixes:**
```
test:integration → 14 suites, 122 tests, 0 passed, 122 failed
test:unit        → 2 suites failed to compile, 0 tests (módulos de src/ no existen)
verify:coverage  → 129/129 IDs contabilizados, 0 MISSING, exit 0
```
Todo en rojo por la razón correcta (`relation "profiles" does not exist`
en integración; `Cannot find module` en unit). Listo para el loop.

## 2026-08-03 — Suite de tests de la capa de datos (sin implementación)

**Qué se hizo:** se escribió la suite completa de tests exigida por
`TASK-db.md` §5, más la configuración necesaria para correrla. No se tocó
ninguna migración, trigger, función SQL, `schema.prisma` ni repository —
solo tests y config, según el encargo de la sesión. Plan aprobado en
`/Users/angelcstd/.claude/plans/prompt-de-primera-sunny-glade.md`.

**Verificado en esta sesión (sin Postgres — Docker no estaba disponible):**
- `npm install` corre limpio.
- `npx tsc --noEmit` no tiene errores propios; los únicos 3 errores
  restantes son `Cannot find module` para `src/shared/money/*` y
  `src/shared/recurrence/next-due-on` — esperado, ese código no existe
  todavía (no se implementó a propósito).
- `npm run test:unit` corre y falla exactamente por esos mismos módulos
  faltantes — confirma que el harness (Jest + ts-jest) funciona.
- `npx jest --listTests` encuentra los 16 archivos `.spec.ts` esperados.
- 129/129 IDs de test de `TASK-db.md` (T-A01…T-N06, incluido T-L04 en el
  script) están cubiertos, verificado por diff programático — cero
  faltantes, cero duplicados inventados.
- `grep it.skip|it.todo|xit|describe.skip test/` → vacío.

**No verificado (requiere Docker corriendo, no disponible en esta sesión):**
`docker compose up -d db-test` y correr la suite de integración de verdad.
Es el siguiente paso obvio y debe dar **todo en rojo** (no existen tablas
todavía) — ver §10 de `TASK-db.md` para levantar el contenedor.

## Supuestos que Luis debe revisar antes de arrancar el loop

1. **Columnas de retorno de F2/F3/F4.** `ARCHITECTURE.md` solo da el
   `CREATE FUNCTION` exacto de F1. Para F2/F3/F4 solo describe el
   contenido en prosa. Se asumieron nombres siguiendo el estilo de F1:
   - F2 `fn_category_balances`: `category_id, name, assigned_cents, spent_cents, available_cents, has_budget`
   - F3 `fn_unassigned_funds`: una fila, columna `unassigned_cents`
   - F4 `fn_transactions_without_period`: `transaction_id, booked_at`

   Si el loop las nombra distinto, hay que alinear
   `test/integration/g-query-functions.spec.ts`,
   `test/integration/j-soft-delete.spec.ts` y
   `test/integration/n-close-cycle.spec.ts` con los nombres reales — no al
   revés.
2. **Modelos de Prisma en `m-bigint.spec.ts` (T-M01).** Se asumió
   `prisma.transaction` / `prisma.entry` (PascalCase singular con
   `@@map`), convención idiomática de Prisma no documentada
   explícitamente. Ajustar si el loop nombra los modelos distinto.
3. **T-L03/T-L08 (nombres de trigger).** Confirmado con Luis en esta
   sesión: se verifica por **conteo**, no por nombre — ningún documento
   nombra los triggers individualmente (solo dan un total de 12).

## Huecos declarados (no es negligencia, está documentado por qué)

- RLS no se testea (decisión ya tomada en `ARCHITECTURE.md` §3.8/§3.15).
- T-M01 no podrá ejecutarse hasta que exista `prisma/schema.prisma` real
  y se corra `prisma generate` — hoy compila gracias al cliente vacío que
  genera el postinstall de `prisma`, pero falla en runtime.
- U24 (reglas de Service) es documental, no entrega test.
- PENDIENTES de §3.14 no se resuelven ni se testean indirectamente;
  T-J01/T-J02 dependen de `profiles.deleted_at` (P-06), que no existe
  todavía.
- `.env` real de Supabase no se creó (no hay credenciales); se dejó
  `.env.example`.

## Qué sigue

1. Luis revisa la tabla de cobertura y los supuestos de arriba.
2. Levantar Docker, correr `docker compose up -d db-test`, confirmar
   `pgcrypto`/`btree_gist` (TASK-db.md §10, pasos 8-9).
3. Confirmar que `profiles` existe en el contenedor (depende de
   `TASK-auth`, D1/D2 de `TASK-db.md` §8).
4. Correr `npm run test:integration` — debe salir todo en rojo. Si algo
   sale en verde sin implementación, hay un bug en el test, no un milagro.
5. Con la suite en rojo confirmado, arrancar el loop de implementación.
