# CLAUDE.md

Contexto permanente del proyecto. Se lee al inicio de cada sesión.

## Qué es esto

App personal de presupuesto con contabilidad de doble partida y sistema de sobres.
Uso privado (yo y un par de amigos), pero construida con estándares de producción.

## Fuentes de verdad — jerarquía

1. **`ARCHITECTURE.md`** — decisiones de arquitectura. **Es de solo lectura.**
   Nunca lo modifiques. Si algo que necesitas no está ahí, o si encuentras una
   contradicción, **detente y pregunta**. No decidas por tu cuenta.
2. **`TASK-db.md`**, **`TASK-auth.md`**, **`TASK-front.md`** — la tarea activa.
3. **`PROGRESS.md`** — estado del trabajo. Actualízalo al final de cada sesión.

Si algo de este archivo contradice al `ARCHITECTURE.md`, gana el `ARCHITECTURE.md`.

## Alcance activo

Este repo es **exclusivamente backend y base de datos**. El frontend vive en un
repositorio separado y no se toca desde aquí — no crees carpetas de UI, no
agregues dependencias de Next.js ni de React, y no escribas código de frontend
aunque parezca que ayuda al problema en curso.

## Stack

- **Backend:** NestJS + TypeScript
- **ORM:** Prisma
- **DB:** PostgreSQL (Supabase en producción, contenedor local para tests)
- **Auth:** Supabase Auth, JWT validado localmente en NestJS
- **Frontend:** Next.js — fuera de alcance por ahora

<!-- TODO Luis: completa las versiones exactas -->

- Node: `v__`
- PostgreSQL: `__` (la local DEBE coincidir con la de Supabase)
- Prisma: `__`

## Comandos

<!-- TODO Luis: ajusta a tus scripts reales -->

```bash
npm run dev                  # levantar en desarrollo
# Migraciones: se escriben a mano y se aplican con deploy — NUNCA con
# migrate dev (ver Reglas duras y TASK-db.md §3 para el flujo completo).
npx prisma migrate deploy    # aplicar migraciones pendientes
npx prisma migrate reset     # resetear la DB desde cero (aplica todas las migraciones)
npx prisma migrate status    # ver drift entre schema.prisma y las migraciones aplicadas
npm run db:check-sync        # verificar que schema.prisma sigue reflejando la base real
npx prisma generate          # regenerar el cliente
npm run test:unit            # tests unitarios
npm run test:integration     # tests de integración (requiere Postgres local)
npm run lint
```

## Reglas duras — no negociables

Vienen del `ARCHITECTURE.md` (RD1, RD2). Romperlas invalida el trabajo:

- **Nunca `prisma db push`.** Todo cambio de schema va en migración versionada.
- **Nunca `prisma migrate dev`, ni con `--create-only`, en ningún entorno.**
  Con `auth.users` fuera de las migraciones de Prisma (decisión de
  `TASK-auth`), `migrate dev` usa una shadow database sin esa tabla y falla
  desde la segunda migración del proyecto en adelante — probado
  empíricamente, ver `TASK-auth.md`. Las migraciones se escriben a mano
  (`TASK-db.md` §3) y se aplican con `migrate deploy`.
- **Nunca crear objetos de base de datos desde la UI de Supabase.** Triggers,
  funciones, políticas RLS, extensiones: todo vive en migraciones del repo.
- **Nunca modificar `ARCHITECTURE.md`.**
- **No resolver PENDIENTES por criterio propio.** El `ARCHITECTURE.md` tiene una
  sección §3.14 de pendientes. Si el trabajo topa con uno, detente y pregunta.
- **No "simplificar" la fórmula de `fn_unassigned_funds`** a una resta agregada.
  La agregación es por par `(categoría, periodo abierto)`. Simplificarla
  reintroduce un bug conocido.

## Trampas de este stack

- **Triggers diferidos.** R1, R2, R4 y R9 son `DEFERRABLE INITIALLY DEFERRED`.
  El error sale en el `COMMIT`, no en el `INSERT`. Un test que espere el error en
  el `INSERT` falla aunque el trigger esté perfecto. Es el fallo más caro aquí.
- **BigInt.** Los montos son `BigInt` (centavos). El override de
  `BigInt.prototype.toJSON` va en la primera línea del bootstrap, antes de
  instanciar cualquier filtro.
- **Prisma bypassa RLS.** Corre como service role. Todo Repository filtra por
  `user_id` explícitamente, siempre. RLS es defensa en profundidad, no la defensa.
- **Prisma no genera triggers.** Van como SQL crudo dentro de las migraciones.
- **`multiSchema` de Prisma no es gratis.** Se necesitaría para que Prisma
  tolere la FK cruzada `profiles → auth.users`, pero activarlo hace que
  Prisma trate `auth` como un schema que gestiona y lo borre en cualquier
  `migrate reset` — no solo en la shadow database de `migrate dev`. Nunca
  declarar `multiSchema` ni un modelo de Prisma para `auth.users`.

## Convenciones

- Repository pattern en datos y en auth. Los Services hablan con interfaces,
  nunca con Prisma ni con el SDK de Supabase directamente.
- Un `GlobalExceptionFilter` centraliza errores y escribe a `ErrorLog`.
- Códigos `P1001`–`P1011` de los triggers mapean a excepciones tipadas de Nest.
  El mapeo está en `TASK-db.md`.
- Montos siempre en centavos, nunca en flotantes.

## Cómo trabajar

- Cuando falte una decisión, **pregunta**. No elijas.
- Cambios chicos y verificables antes que refactors grandes.
- Actualiza `PROGRESS.md` antes de terminar la sesión: qué quedó hecho, qué falló,
  qué aprendiste que no estaba documentado.
