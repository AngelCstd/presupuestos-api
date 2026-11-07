# TASK-auth.md

## Condición de paro

La tarea termina cuando, ejecutados **por separado** (nunca encadenados con `&&`):

```
npm run test:unit
```
retorna código de salida 0, **y**
```
npm run test:integration:auth
```
retorna código de salida 0.

**Los tests #14–#16 (módulo de refresh del MCP) son unit tests, no de integración** — no tocan red ni DB gracias a la inyección de `RefreshFn` y `now`. Viven en la suite de `test:unit`, que pasa de 10 a 13 tests con esta tarea. `test:integration:auth` **no** los cubre; ambos comandos son necesarios para la condición de paro.

`test:integration:auth` corre solo los tests de esta tarea (ver "Scripts de test" abajo) contra el Postgres local de Docker, con el bootstrap de `auth.users`/`auth.uid()` y la migración de `profiles` ya aplicados vía `globalSetup` de Jest — no depende de que se haya invocado ningún hook `pretest` específico.

`test:integration` (sin sufijo, toda la suite) es la verificación final una vez que esta tarea y `TASK-db` estén ambas cerradas — **no es condición de paro de ninguna de las dos individualmente.**

## Scripts de test

El `jest.config.js` existente usa `testMatch: ['<rootDir>/test/**/*.spec.ts']` — un glob genérico sin distinción por tarea. La separación **no se logra con `testMatch`**, se logra filtrando por ruta con `--testPathPattern` en cada script, y organizando los archivos de esta tarea en su propia carpeta para que el patrón sea limpio:

```
package.json
  ⚠️ La fuente de verdad es el package.json real del repo, NO este bloque.
  "scripts": {
    "test:integration:auth": "dotenv -e .env.test -- jest --config test/jest-integration.config.js --runInBand --testPathPattern=\"test/integration/auth/\"",
    "test:integration:db": "dotenv -e .env.test -- jest --config test/jest-integration.config.js --runInBand --testPathIgnorePatterns=\"test/integration/auth/\"",
    "test:integration": "dotenv -e .env.test -- jest --config test/jest-integration.config.js --runInBand"
  }
```

`--runInBand` va como flag de CLI aquí (no en el config, donde no es una opción válida); el `maxWorkers: 1` del config cubre el mismo efecto de forma redundante y deliberada.

| Script | Filtro | Condición de paro de |
|---|---|---|
| `test:integration:auth` | Solo `test/integration/auth/` | Esta tarea |
| `test:integration:db` | Todo excepto `test/integration/auth/` | `TASK-db.md` |
| `test:integration` | Sin filtro | Ninguna individualmente — verificación final combinada |

**Todos los archivos de test nuevos de esta tarea viven en `test/integration/auth/`.** Los archivos existentes de la capa de datos no se mueven — el filtro por exclusión (`--testPathIgnorePatterns`) los cubre sin tocarlos.

**Nombres de archivo confirmados sin cambio:** `testMatch` es un glob genérico sobre cualquier `.spec.ts` dentro de `test/`, no exige el prefijo de letra de la suite existente. `auth.integration.spec.ts`, `profile-creation.integration.spec.ts`, etc. matchean sin ajuste.

## Bootstrap de `auth.users` — vía `globalSetup` de Jest, no `pretest`

**Confirmado: opción (b), script fuera de las migraciones de Prisma.** El schema `auth` lo mantiene Supabase; no se compite con él en la cadena de migraciones versionadas.

**Dónde se ejecuta:** en el `globalSetup` de la config de Jest de integración, no en un hook `npm pretest:integration`. Con tres scripts distintos invocables (`test:integration:auth`, `test:integration:db`, `test:integration`), un hook `pretest` específico no dispara si se invoca otro script — el `globalSetup` corre sin importar cuál de los tres se use, así que ningún loop puede saltárselo por accidente.

```js
// test/jest-integration.config.js
// ⚠️ La fuente de verdad es el archivo real del repo, NO este bloque.
// Reproducido aquí solo como referencia de qué debe contener.
// NO restaurar el config desde este documento.
module.exports = {
  rootDir: '../',              // obligatorio: sin él, el patrón resuelve a
                               // test/test/** y la suite pasa vacía en verde
  testMatch: ['<rootDir>/test/**/*.spec.ts'],
  globalSetup: '<rootDir>/test/setup/global-setup.ts',
  maxWorkers: 1,               // secuencial; `runInBand` es flag de CLI, no
                               // opción de config — no ponerlo aquí
  testTimeout: 30000,
};
```

```ts
// test/setup/global-setup.ts
// Corre una vez antes de toda la suite (sin importar el script invocado).
// Idempotente: seguro de correr contra una DB que ya tiene el stub aplicado.
import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';

export default async function globalSetup() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const sql = readFileSync(join(__dirname, 'local-auth-stub.sql'), 'utf-8');
  await client.query(sql);
  await client.end();
}
```

```sql
-- test/setup/local-auth-stub.sql
-- Bootstrap mínimo de Supabase Auth para Postgres puro (Docker local).
-- NO se ejecuta contra Supabase real — solo contra el contenedor de tests.

CREATE SCHEMA IF NOT EXISTS auth;

CREATE TABLE IF NOT EXISTS auth.users (
  id uuid PRIMARY KEY
);

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE
AS $$
  SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
```

**Fixture — cambio obligatorio, afecta a `TASK-db` también:** `test/setup/fixture.ts` inserta hoy directo en `profiles`. Con la FK a `auth.users`, ese insert falla por violación de llave foránea — y con él, los 123 tests de la capa de datos, no solo los de esta tarea. `seedUser` (o el helper equivalente del fixture) debe insertar primero la fila en `auth.users` (solo `id`) y **después** la de `profiles`. Este cambio es prerequisito de ambos loops, no exclusivo de `TASK-auth`.

## Alcance explícito

- Un solo tipo de usuario, sin roles ni columna de permisos en `profiles`.
- Sin rate limiting en ningún endpoint.
- MCP en modo de un solo usuario: refresh token vía variable de entorno. No se implementa `McpConnection`.
- Sin integración con logging externo.
- No se toca frontend.
- **RLS sobre `profiles` no se verifica por test en este entorno** (conflicto C1, decisión 22 del `ARCHITECTURE.md`: Postgres local no emula el contexto de autenticación de Supabase). Las policies siguen en la migración como defensa en profundidad real contra Supabase; sin cobertura de test local.

## Entregables

- Migración de `profiles` — entregada por separado (`ON DELETE RESTRICT`, sin trigger de `updated_at`, policies de RLS). Prerequisito de esta tarea.
- `test/setup/local-auth-stub.sql` — bootstrap de `auth.users`/`auth.uid()`.
- `test/setup/global-setup.ts` — ejecuta el stub una vez antes de toda la suite de integración.
- `test/jest-integration.config.js` (o el archivo real de config de integración del repo) — agregar `globalSetup`.
- Actualización de `test/setup/fixture.ts` — `auth.users` antes de `profiles`.
- Nuevos scripts en `package.json`: `test:integration:auth`, `test:integration:db`, `test:integration` (ver "Scripts de test").
- `IAuthRepository` (interfaz) — `validateToken(token: string): Promise<{ userId: string; email: string }>`.
- `SupabaseAuthRepository implements IAuthRepository` — valida el JWT localmente contra el JWKS de Supabase (llaves públicas, cacheadas, buscadas por `kid`).
- `AuthGuard` — extrae `Authorization`, delega a `IAuthRepository`, adjunta `{ userId, email }` al request. Responsabilidad única: validar token. No crea perfiles.
- `EnsureProfileExists` (servicio, corre después de `AuthGuard`) — upsert idempotente de `profiles` vía SQL crudo con `RETURNING`.
- Binding del provider: `{ provide: 'IAuthRepository', useClass: SupabaseAuthRepository }`.
- `GlobalExceptionFilter` — formato de error consistente, nunca expone stack trace, escribe en `ErrorLog` best-effort.
- Override de `BigInt.prototype.toJSON`, registrado en la primera línea del bootstrap (`main.ts`), antes de instanciar `GlobalExceptionFilter`.
- Serializador defensivo en la escritura de `ErrorLog`: cualquier valor de `metadata` no convertible a JSON se reemplaza por un string legible, en vez de lanzar excepción.
- Modelo Prisma `ErrorLog`: `message`, `stack`, `context`, `userId` (nullable), `metadata` (Json, nullable), `createdAt`.
- `ValidationPipe` global: `whitelist`, `forbidNonWhitelisted`, `transform`.
- Módulo de refresh de token del MCP (uso propio) — `McpTokenRefreshService` + `createSupabaseRefreshFn`, contrato completo especificado en "Contrato del módulo de refresh de token del MCP".

## Mecánica de creación de `profiles`

- **Punto de creación:** lazy, en el primer request autenticado sin fila correspondiente en `profiles`. Sin trigger sobre `auth.users`, sin webhook de signup — el backend la crea con `service_role`.
- **Query (SQL crudo, no vía métodos generados de Prisma):**
  ```sql
  INSERT INTO profiles (id)
  VALUES ($1)
  ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id
  RETURNING id, timezone, deleted_at, created_at, updated_at;
  ```
- **Por qué `DO UPDATE SET id = EXCLUDED.id` en vez de `DO NOTHING`:** `RETURNING` solo devuelve filas que Postgres realmente tocó. Con `DO NOTHING`, en el caso de conflicto no hay fila que retornar. El `SET id = EXCLUDED.id` es un no-op de valor que cuenta como operación para `RETURNING`.
- **Obligatorio: SQL crudo, nunca `prisma.profile.upsert()`** — evita que `@updatedAt` toque `updated_at` en cada request autenticado sin cambios reales.
- **Nota de performance, no a resolver ahora:** el `DO UPDATE` toma un row lock de escritura en cada request autenticado, aunque sea no-op.
- **Usuario con `deleted_at IS NOT NULL` que vuelve a autenticarse — PENDIENTE, no resuelto.** No está definido en `ARCHITECTURE.md`. Mientras no se decida: `EnsureProfileExists` inspecciona el `deleted_at` retornado y, si no es nulo, lanza `ProfileDeletedException` (403). El loop no debe implementar reactivación.

## Contrato del módulo de refresh de token del MCP

Especificación completa de la interfaz. `ARCHITECTURE.md` §5 solo establece que la lógica vive "aislada en un módulo/función propia del MCP" y que el refresh token viene de `MCP_USER_REFRESH_TOKEN`; lo siguiente es la especificación derivada, sin cambio de diseño.

### Clase y método público

```ts
// mcp/auth/token-refresh.service.ts

export interface RefreshedSession {
  accessToken: string;
  /** Instante absoluto de expiración del access token, en epoch ms. */
  expiresAt: number;
}

/** Función que ejecuta el refresh real contra Supabase. Inyectada para ser mockeable. */
export type RefreshFn = (refreshToken: string) => Promise<RefreshedSession>;

export class McpTokenRefreshService {
  constructor(
    private readonly refreshFn: RefreshFn,
    private readonly refreshToken: string,
    private readonly now: () => number = () => Date.now(),
    private readonly skewMs: number = 60_000,
  ) {}

  /**
   * Devuelve un access token vigente. Si el cacheado sigue vigente (con margen
   * de `skewMs`), lo devuelve sin llamar a `refreshFn`. Si no, refresca,
   * actualiza el cache y devuelve el nuevo.
   */
  async getAccessToken(): Promise<string> { /* ... */ }
}
```

- **Método público: `getAccessToken(): Promise<string>`.** Es el único punto de entrada. No recibe parámetros — el refresh token viene del constructor, no del caller, para que ningún punto de llamada pueda pasar uno distinto por accidente.
- **No expone métodos de invalidación manual ni de inspección del cache.** Si un test necesita simular cache vacío, construye una instancia nueva.

### Inyección de la función de refresh

`refreshFn` se inyecta por constructor como una función, **no** como el cliente de Supabase completo. Razón: el módulo no debe conocer el SDK de Supabase — solo el contrato "dame un refresh token, te devuelvo `{ accessToken, expiresAt }`". Esto es lo que hace los tests #14 y #15 posibles sin red ni mock del SDK: se pasa un `jest.fn()` que devuelve un `RefreshedSession` fijo, y se cuenta cuántas veces se llamó.

La implementación real (la que sí toca Supabase) vive en un factory separado, fuera de la clase:

```ts
// mcp/auth/supabase-refresh-fn.ts
export const createSupabaseRefreshFn = (url: string, anonKey: string): RefreshFn =>
  async (refreshToken) => { /* llama a Supabase, mapea a RefreshedSession */ };
```

**Conversión de unidades — obligatoria y no verificable por los unit tests.** Supabase devuelve `expires_in` en **segundos** (duración relativa) o `expires_at` en **epoch segundos**. `RefreshedSession.expiresAt` es **epoch milisegundos**. `createSupabaseRefreshFn` es el único punto donde ocurre la conversión:

- Desde `expires_in` (segundos): `expiresAt = Date.now() + expires_in * 1000`
- Desde `expires_at` (epoch segundos): `expiresAt = expires_at * 1000`

**Por qué esto importa más de lo que parece:** los tests #14–#16 inyectan `refreshFn` mockeada, que devuelve `expiresAt` ya en ms — así que **ningún test de esta suite detecta un `× 1000` faltante**. Un error aquí no rompe nada visible: el token se considera expirado desde el primer segundo y el MCP refresca en cada llamada, silenciosamente. Verificar en code review, no confiar en los tests.

`now` también se inyecta (con default `Date.now`) para que los tests puedan simular el paso del tiempo sin timers reales — necesario para el caso "token vigente" vs. "token expirado" sin esperar en tiempo real, especialmente con `testTimeout` de 30s.

### Representación del cache

- **En memoria del proceso, en un campo privado de la instancia.** No Redis, no disco, no variable global. El MCP es un proceso de un solo usuario en esta fase; el cache muere con el proceso y eso es correcto.
- **Forma:** `private cached: RefreshedSession | null = null`. `null` = cache vacío (nunca se ha refrescado, o instancia recién construida).
- **Criterio de vigencia:** el token cacheado se considera vigente si `this.now() < cached.expiresAt - skewMs`. El margen (`skewMs`, default 60s) evita usar un token que expira a mitad del request en vuelo.
- **`expiresAt` se calcula al momento del refresh**, a partir de lo que devuelva `refreshFn` — se almacena como instante absoluto (epoch ms), no como duración relativa, para que no dependa de cuánto tiempo lleve la instancia viva.
- **Concurrencia:** dos llamadas simultáneas a `getAccessToken()` con cache vacío podrían disparar dos refreshes. Aceptable en esta fase (proceso de un solo usuario, sin concurrencia real). No implementar deduplicación de promesa en vuelo — sería complejidad sin caso de uso actual.

### Qué pasa si el refresh falla

**Propagación con excepción tipada, sin reintento automático.**

```ts
export class McpRefreshFailedException extends Error {
  constructor(readonly cause: unknown) {
    super('MCP refresh token inválido o revocado; se requiere reconexión manual');
  }
}
```

- Si `refreshFn` rechaza, `getAccessToken()` lanza `McpRefreshFailedException` envolviendo la causa original.
- **El cache no se actualiza ni se limpia** en caso de fallo. **Esto es detalle de implementación, no comportamiento verificable:** la clase no expone inspección del cache, y aunque la expusiera, un token cacheado expirado produce el mismo comportamiento observable que un cache vacío (ambos disparan un refresh en la siguiente llamada). El test #16 **no** debe intentar verificarlo — solo la excepción y el conteo de llamadas a `refreshFn`.
- **Sin reintento automático, sin backoff.** Un refresh token revocado no se arregla reintentando; reintentar solo agrega latencia y ruido. La recuperación en esta fase es manual: regenerar `MCP_USER_REFRESH_TOKEN` (acción humana #5).
- **NOTA:** `ARCHITECTURE.md` §5 ubica el "manejo explícito de reconexión cuando el refresh token expira o se revoca" en **Fase 2**. Para Fase 1 no había nada escrito; lo anterior (propagación tipada, sin reintento) es la especificación mínima conservadora. Si se prefiere reintento con backoff, hay que decidirlo explícitamente antes de que el loop implemente — el agente no debe agregarlo por criterio propio.

### Variables de entorno

| Variable | Origen | Uso |
|---|---|---|
| `MCP_USER_REFRESH_TOKEN` | Capturado del login manual (acción humana #5) | Se pasa al constructor de `McpTokenRefreshService`; ya definida en `ARCHITECTURE.md` §5 |
| `SUPABASE_URL` | Dashboard → Settings → API | Consumida por `createSupabaseRefreshFn`; mismo nombre que usa el backend |
| `SUPABASE_ANON_KEY` | Dashboard → Settings → API | Consumida por `createSupabaseRefreshFn`; mismo nombre que usa el backend |

El proceso MCP **nunca** usa `SUPABASE_SERVICE_ROLE_KEY` ni las llaves de firma del JWKS — solo obtiene tokens de usuario y le pega a la API NestJS como cualquier cliente.

### Precisión sobre los tests #14 y #15

Ambos son **unit tests**, no de integración — no tocan red ni DB, así que viven en la suite de `test:unit`, no en `test/integration/auth/`.

- **#14:** construir el servicio, llamar `getAccessToken()` una vez (que refresca y cachea), avanzar `now` a un valor aún dentro de la vigencia, llamar de nuevo → `refreshFn` debe haberse llamado **exactamente una vez**.
- **#15:** construir el servicio, llamar `getAccessToken()`, avanzar `now` más allá de `expiresAt - skewMs`, llamar de nuevo → `refreshFn` debe haberse llamado **dos veces**, la segunda con el mismo `refreshToken` de entorno.

## Formas fijadas — nombres exactos, no inferibles

Estas firmas quedaron fijadas por la suite de tests ya escrita. El agente **no** debe renombrarlas ni cambiar sus firmas; si algo no encaja, es el documento el que se corrige, no el nombre.

### `EnsureProfileExistsService`

```ts
// src/auth/services/ensure-profile-exists.service.ts

export interface ProfileRow {
  id: string;
  timezone: string;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export class EnsureProfileExistsService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Upsert idempotente de la fila de `profiles` vía $queryRaw.
   * Lanza ProfileDeletedException si la fila retornada tiene deleted_at != null.
   */
  async ensure(userId: string): Promise<ProfileRow> { /* ... */ }
}
```

- Recibe `PrismaClient` directo por constructor (no una interfaz `IProfileRepository`) — es una operación de infraestructura de sesión, no lógica de dominio.
- `ProfileRow` usa los nombres de columna de la base (`deleted_at`, `created_at`, `updated_at`, en snake_case), no los del modelo de Prisma — es el resultado crudo del `$queryRaw`, sin mapeo del ORM.

### `ProfileDeletedException`

```ts
// src/auth/exceptions/profile-deleted.exception.ts

export class ProfileDeletedException extends ForbiddenException { /* ... */ }
```

Ruta exacta: `src/auth/exceptions/profile-deleted.exception.ts`. Un archivo por excepción; no agrupar en un barrel de excepciones en esta tarea.

### `ErrorLogRepository`

```ts
// src/common/logging/error-log.repository.ts

export class ErrorLogRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /** Devuelve la fila insertada. Aplica el serializador defensivo sobre `metadata`. */
  async write(entry: ErrorLogEntry): Promise<ErrorLogRow> { /* ... */ }
}
```

- El método es `write`, no `create` ni `log`.
- **Devuelve la fila insertada**, no `void` — los tests verifican el contenido persistido (en particular el caso #11, `BigInt` serializado).
- El carácter best-effort de la escritura lo maneja quien la llama (`GlobalExceptionFilter`, con su propio `.catch()`), **no** `write()` — este método sí propaga si falla, para que el test #10 pueda simular el fallo.

### Claims del JWT

| Claim | Significado |
|---|---|
| `sub` | `userId` — única fuente del identificador de usuario en todo el sistema |
| `email` | Email del usuario |
| `role` / `aud` | Valor `authenticated` |

**Nota:** `role: 'authenticated'` es un claim estándar de Supabase Auth, presente en todo JWT que emite. **No** es el modelo de roles de aplicación, que sigue fuera de alcance (ver "Alcance explícito"). `AuthGuard` no debe derivar permisos de negocio de este claim; solo lo lee si necesita verificar que el token es de un usuario autenticado y no de otro tipo.

## Orden de ejecución (grafo de dependencias)

```
global-setup.ts (corre local-auth-stub.sql: schema auth, auth.users, auth.uid())
        │  ── se dispara automáticamente al invocar cualquiera de los tres
        │     scripts de test:integration:*, sin acción manual adicional
        ▼
fixture.ts actualizado (auth.users antes de profiles)
        │
        ▼
migración `profiles` (prerequisito, entregada aparte — requiere que
auth.users ya exista para que la FK resuelva)
        │
        ▼
`prisma generate` con el schema actualizado
        │
        ├──▶ IAuthRepository (interfaz, sin dependencias externas)
        │        │
        │        ▼
        │   SupabaseAuthRepository (requiere SUPABASE_URL, para derivar
        │   el endpoint JWKS)
        │        │
        │        ▼
        │   AuthGuard (requiere IAuthRepository inyectable)
        │        │
        │        ▼
        │   EnsureProfileExists (requiere AuthGuard ya validando;
        │   requiere service_role; usa $queryRaw)
        │        │
        │        ▼
        │   Endpoints protegidos + tests en test/integration/auth/
        │
        ├──▶ Override de BigInt.prototype.toJSON (main.ts, primera línea)
        │        ──▶ Serializador defensivo de ErrorLog ──▶ GlobalExceptionFilter
        │        ──▶ tests del filter (incluyendo caso BigInt)
        │
        └──▶ Módulo de refresh del MCP (independiente)
```

**Qué se rompe si se ejecuta fuera de orden:**
- Si `global-setup.ts` no está en la config de Jest, la migración de `profiles` falla la FK a `auth.users` al primer intento de `test:integration:auth`.
- Si el fixture no se actualiza antes de correr cualquier suite, los 123 tests de la capa de datos truenan por FK, no por lógica de negocio.
- Implementar `EnsureProfileExists` con `prisma.profile.upsert()` rompe silenciosamente la decisión de `updated_at` — revisar en code review, no solo confiar en el test #6.
- Registrar el override de `BigInt.prototype.toJSON` después de instanciar `GlobalExceptionFilter` deja una ventana donde el primer error con `BigInt` en contexto truena el propio manejador de errores.

## Criterios de aceptación

**Dado** un request sin header `Authorization` a una ruta protegida, **cuando** llega a `AuthGuard`, **entonces** responde 401 sin ejecutar `EnsureProfileExists`, el controller ni el service.

**Dado** un JWT expirado, **cuando** `SupabaseAuthRepository.validateToken()` lo procesa, **entonces** produce 401 con mensaje genérico.

**Dado** un JWT válido de un usuario sin fila previa en `profiles`, **cuando** pasa por `EnsureProfileExists`, **entonces** se crea la fila en un solo round-trip y el request continúa.

**Dado** un JWT válido de un usuario con fila ya existente, **cuando** pasa por `EnsureProfileExists`, **entonces** la fila se retorna sin modificar `updated_at`.

**Dado** dos escrituras concurrentes de `EnsureProfileExists` para el mismo usuario nuevo, ejecutadas dentro de un mismo test sobre dos conexiones distintas del pool, **cuando** ambas corren en paralelo, **entonces** ninguna falla por violación de PK, y al final existe exactamente una fila.

**Dado** un JWT válido de un usuario cuyo `profiles.deleted_at` no es nulo, **cuando** pasa por `EnsureProfileExists`, **entonces** se lanza `ProfileDeletedException` (403).

**Dado** un JWT válido y `userId` distinto en el body, **cuando** el service ejecuta la acción, **entonces** usa el `userId` del token, nunca el del body.

**Dado** un error no controlado cuyo contexto incluye un valor `BigInt`, **cuando** llega a `GlobalExceptionFilter`, **entonces** el registro en `ErrorLog` se completa sin excepción, con el valor serializado como string legible.

**Dado** un error no controlado en cualquier capa, **cuando** llega a `GlobalExceptionFilter`, **entonces** el cliente recibe 500 genérico y se intenta un registro best-effort en `ErrorLog`.

## Tests requeridos antes de implementar

| # | Caso | Entrada | Resultado esperado |
|---|---|---|---|
| 1 | Sin token | Request sin header `Authorization` | 401, nada más se ejecuta |
| 2 | Token con firma inválida | JWT malformado/alterado | 401, sin 500 |
| 3 | Token expirado | JWT con `exp` en el pasado | 401, mensaje genérico |
| 4 | Token válido, perfil inexistente | JWT válido, usuario sin fila en `profiles` | Se crea la fila en un solo query; 200/201 |
| 5 | Token válido, perfil existente | JWT válido, usuario con fila ya creada | Fila retornada sin modificar `updated_at`; 200/201 |
| 6 | `updated_at` no cambia en request repetido | Dos requests autenticados seguidos del mismo usuario existente | `updated_at` idéntico entre ambos |
| 7 | Concurrencia en creación de perfil — **ver nota de implementación abajo** | Dos queries de `EnsureProfileExists` para el mismo usuario nuevo, lanzadas en paralelo dentro del mismo test usando dos conexiones distintas del pool (`Promise.all`, no dos `it()` separados) | Ninguna falla por violación de PK; una sola fila resultante |
| 8 | Perfil con soft delete | JWT válido, usuario con `deleted_at IS NOT NULL` | `ProfileDeletedException`, 403, no reactivación |
| 9 | Aislamiento entre usuarios | Token de A + `userId` de B en el body | Acción ejecutada con `userId` de A |
| 10 | Fallo al escribir `ErrorLog` | Mock que lanza excepción en el insert | Respuesta al cliente no afectada |
| 11 | `ErrorLog` con `BigInt` en `metadata` | Contexto de error incluye un valor `BigInt` | Se escribe sin excepción; valor legible en el registro |
| 12 | Error no controlado | Excepción genérica de una capa interna | 500 genérico, sin stack trace expuesto |
| 13 | `ValidationPipe` rechaza campos extra | DTO con propiedad no declarada | 400 |
| 14 | MCP refresh — token vigente (**unit**, no integración) | `McpTokenRefreshService` con `refreshFn` mockeado y `now` inyectado; una llamada a `getAccessToken()`, luego avanzar `now` dentro de la vigencia, segunda llamada | `refreshFn` llamada exactamente **una** vez; ambas llamadas devuelven el mismo access token |
| 15 | MCP refresh — token vencido/ausente (**unit**, no integración) | Igual, pero avanzando `now` más allá de `expiresAt - skewMs` antes de la segunda llamada | `refreshFn` llamada **dos** veces, la segunda con el mismo `refreshToken`; se devuelve el token nuevo |
| 16 | MCP refresh — fallo del refresh | `refreshFn` mockeada para rechazar | `getAccessToken()` lanza `McpRefreshFailedException`; `refreshFn` llamada **exactamente una** vez (sin reintento) |

**Nota de implementación obligatoria para el test #7:** la suite de integración corre con `--runInBand` (secuencial, un test a la vez) y `testTimeout` de 30s. Jest **no** va a correr dos `it()` en paralelo bajo esta config — si el test se escribe como dos casos separados esperando que coincidan en el tiempo, nunca va a ejercer la condición de carrera real. La concurrencia tiene que simularse **dentro de un solo test**, dos llamadas a `EnsureProfileExists` lanzadas con `Promise.all` sobre conexiones distintas del pool de Postgres. El agente no debe implementarlo de la otra forma.

**Fuera de esta tabla, deliberadamente:** tests de RLS sobre `profiles`. No pueden pasar en Postgres local sin el contexto de autenticación de Supabase — ver "Alcance explícito".

## Mapeo de errores → excepción NestJS → status HTTP

| Situación | Excepción NestJS | HTTP Status |
|---|---|---|
| Sin token / token inválido / expirado | `UnauthorizedException` | 401 |
| Usuario con `deleted_at` no nulo intentando autenticarse | `ProfileDeletedException extends ForbiddenException` (custom) | 403 |
| Usuario autenticado sin permiso para la acción | `ForbiddenException` | 403 |
| DTO inválido o con campos no declarados | `BadRequestException` (vía `ValidationPipe`) | 400 |
| Recurso no encontrado | `NotFoundException` | 404 |
| Error no controlado | Excepción no `HttpException`, capturada por `GlobalExceptionFilter` | 500 |

## Acciones humanas requeridas

1. **Obtener `SUPABASE_URL` y `SUPABASE_ANON_KEY`.** Dashboard → Settings → API → `.env`. Verificación: `SUPABASE_ANON_KEY` empieza con `eyJ`.

   `SUPABASE_URL` cubre ahora **dos** consumidores: el módulo de refresh del MCP y `SupabaseAuthRepository`, que deriva de ahí el endpoint JWKS (`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`).

   *(Una versión previa de este documento abría con una acción separada para obtener el "JWT Secret" del dashboard y guardarlo como `SUPABASE_JWT_SECRET`. Se eliminó: el proyecto migró a JWT Signing Keys asimétricas (ECC P-256 / ES256), los tokens de usuario ya no se firman con un secret compartido, y el "Legacy JWT Secret" que sigue apareciendo en el dashboard solo verifica las API keys `anon` y `service_role`, no los tokens de usuario. `SupabaseAuthRepository` no necesita ningún secret.)*
2. **Obtener la `service_role key`.** Dashboard → Settings → API → `.env` como `SUPABASE_SERVICE_ROLE_KEY`. **Nunca exponer al frontend.**
3. **Confirmar `DATABASE_URL` de conexión directa** (puerto 5432). Verificación: `npx prisma db pull` conecta sin error.
4. **Generar el refresh token del MCP.** Login manual una vez, capturar `refresh_token`, guardarlo como `MCP_USER_REFRESH_TOKEN`.
5. **Levantar Postgres local vía Docker y aplicar migraciones.** `docker compose up -d` → `npx prisma migrate deploy`. El stub de `auth.users` ya no requiere un paso manual separado — corre automático vía `globalSetup` al invocar cualquier script `test:integration:*`. Verificación: `npm run test:integration:auth` conecta sin error de FK ni de schema faltante.
6. **Definir y comunicar la decisión PENDIENTE** de qué pasa con un usuario `deleted_at IS NOT NULL` que vuelve a autenticarse. Hasta entonces, el comportamiento implementado es el rechazo explícito (test #8).

## Qué NO debe hacer el agente

- No ejecutar `prisma db push`.
- No crear tablas, columnas ni policies desde la UI de Supabase.
- No modificar `ARCHITECTURE.md`.
- No implementar `EnsureProfileExists` con `prisma.profile.upsert()` ni ningún método generado de Prisma — debe ser `$queryRaw`/`$queryRawUnsafe`.
- No decidir por su cuenta el comportamiento ante `deleted_at IS NOT NULL` — debe implementar el rechazo explícito.
- No agregar columna de rol ni lógica de permisos por rol.
- No agregar trigger de `updated_at` en `profiles` ni en ninguna otra tabla.
- No implementar `McpConnection`, flujo OAuth del MCP, ni rate limiting.
- No escribir tests de RLS sobre `profiles` en este entorno.
- No usar `npm run test:integration` (sin sufijo) como condición de paro de esta tarea.
- No colgar el bootstrap de `auth.users` de un hook `pretest:integration` — debe vivir en `globalSetup` de Jest.
- No implementar el test de concurrencia (#7) esperando que Jest corra dos `it()` en paralelo — la suite corre con `--runInBand`; la concurrencia se simula dentro de un solo test con `Promise.all`.
- No agregar reintento automático ni backoff al fallo de refresh del MCP — la especificación es propagación tipada; cambiarlo requiere decisión explícita.
- No inyectar el cliente de Supabase directamente en `McpTokenRefreshService` — debe recibir una `RefreshFn`, para que sea mockeable sin el SDK.
- No implementar deduplicación de promesa en vuelo en `getAccessToken()` — fuera de alcance en esta fase.
- No usar `SUPABASE_SERVICE_ROLE_KEY` ni las llaves de firma del JWKS en el proceso MCP.
- No colocar los tests #14–#16 del MCP en `test/integration/auth/` — son unit tests, van en la suite de `test:unit`.
- No renombrar ni cambiar las firmas de "Formas fijadas" (`EnsureProfileExistsService.ensure`, `ProfileDeletedException`, `ErrorLogRepository.write`, claims del JWT) — la suite de tests ya está escrita contra ellas.
- No derivar permisos de negocio del claim `role: 'authenticated'` — es un claim estándar de Supabase, no el modelo de roles de aplicación.
- No hacer que `ErrorLogRepository.write()` absorba sus propios errores — el `.catch()` best-effort vive en `GlobalExceptionFilter`, no en el repository.
- No mover ni renombrar los archivos de test existentes de la capa de datos.
- No tocar código de frontend.

## Dependencias con TASK-db

- `test/setup/global-setup.ts` y `local-auth-stub.sql` son prerequisito de **ambas** tareas — sin `auth.users`, ninguna migración que la referencie puede aplicarse en el Postgres local.
- `test/setup/fixture.ts` debe actualizarse (auth.users antes de profiles) antes de que cualquiera de los dos loops corra — no es exclusivo de esta tarea.
- Toda migración de `02a_accounts` en adelante depende de que `profiles` exista.
- Los tests de esta tarea viven exclusivamente en `test/integration/auth/`; los de `TASK-db` viven en cualquier otra ruta de `test/integration/`. `test:integration:db` los cubre por exclusión, sin necesidad de listarlos ni moverlos.
- Nada de `TASK-db` depende del código de esta tarea más allá de la tabla `profiles` y el bootstrap de `auth.users`.

## Estructura de archivos esperada

```
src/
  auth/
    auth.module.ts
    guards/
      auth.guard.ts
    interfaces/
      auth-repository.interface.ts
    repositories/
      supabase-auth.repository.ts
    services/
      ensure-profile-exists.service.ts
    exceptions/
      profile-deleted.exception.ts
  common/
    filters/
      global-exception.filter.ts
    logging/
      error-log.repository.ts
      error-log-serializer.ts
    bootstrap/
      bigint-json-override.ts
  main.ts   (importa bigint-json-override como primera línea)
mcp/
  auth/
    token-refresh.service.ts        (McpTokenRefreshService, RefreshFn, RefreshedSession)
    supabase-refresh-fn.ts          (createSupabaseRefreshFn — única pieza que toca el SDK)
    mcp-refresh-failed.exception.ts
prisma/
  schema.prisma
docker-compose.yml
test/
  jest-integration.config.js   (agrega globalSetup)
  setup/
    global-setup.ts
    local-auth-stub.sql
    fixture.ts   (actualizado: auth.users antes de profiles)
  integration/
    auth/
      auth-guard.integration.spec.ts
      profile-creation.integration.spec.ts
      error-log-serializer.integration.spec.ts
    <archivos existentes de la capa de datos, sin mover>
```
