---
name: verify
description: Corre la verificación completa de la capa de datos y reporta si la tarea está terminada o no. Úsala al final de cada vuelta del loop de implementación, después de cualquier cambio a migraciones, triggers, funciones SQL, schema de Prisma o repositories. También cuando el usuario pregunte si ya quedó, si los tests pasan, o si se puede parar.
---

# Verificación de la capa de datos

Esta skill es la **condición de paro del loop**. Su salida decide si el trabajo
continúa o se detiene. No es un resumen ni una opinión: es un veredicto binario.

## Procedimiento

Corre en este orden y detente en el primer paso que falle:

```bash
# 1. El contenedor de Postgres debe estar arriba
# TODO Luis: ajusta al nombre real de tu contenedor
docker ps --filter "name=__" --format "{{.Names}}"

# 2. Reconstruir la base desde cero, solo con migraciones
npx prisma migrate reset --force --skip-seed

# 3. No debe quedar drift entre schema y migraciones
npx prisma migrate status

# 4. El cliente compila
npx prisma generate
npm run build

# 5a. Tests de integración
npm run test:integration

# 5b. Tests unitarios — SIEMPRE, aunque 5a haya fallado.
# No encadenar con &&: con la integración en rojo (que es el estado
# normal durante casi todo el loop), los unitarios nunca correrían
# y una regresión ahí sería invisible.
npm run test:unit
```

## Veredicto

Reporta exactamente en este formato:

```
VERIFICACIÓN: VERDE | ROJO

Migraciones:  ok / falló en <migración>
Drift:        ninguno / <descripción>
Build:        ok / <error>
Tests:        <pasaron>/<total>

Fallos:
- <nombre del test> → <qué esperaba> vs <qué pasó>

Tests integración:  <pasaron>/<total>
Tests unitarios:    <pasaron>/<total>
```

**VERDE** solo si los cinco pasos pasaron y cero tests fallaron.
Cualquier otra cosa es **ROJO**. No hay "verde con observaciones".

## Cómo interpretar los fallos

Antes de tocar código, clasifica el fallo. La mayoría de las vueltas perdidas
vienen de arreglar lo que no estaba roto:

- **Un test de trigger diferido falla esperando el error en el `INSERT`.**
  El trigger probablemente está bien; el test está mal estructurado. R1, R2, R4 y
  R9 son `DEFERRABLE INITIALLY DEFERRED` y lanzan en el `COMMIT`. Antes de tocar
  el trigger, verifica dónde espera el error el test.

- **Falla el reset pero los tests individuales pasarían.**
  Es orden de migraciones, no lógica. Revisa el grafo de dependencias en
  `TASK-db.md` antes de cambiar cualquier SQL.

- **Falla un test de `fn_unassigned_funds` por un monto exacto.**
  Compáralo contra los tres ejemplos canónicos de §3.9 del `ARCHITECTURE.md`.
  Si el resultado coincide con la resta agregada global, la fórmula se simplificó
  y hay que revertirla — está prohibido explícitamente.

- **Falla algo que requiere una decisión que no está en `ARCHITECTURE.md`.**
  Detente. No elijas un comportamiento. Reporta ROJO, describe la decisión que
  falta, y espera respuesta del usuario.

## Reglas

- **Nunca modifiques un test para que pase.** Si crees que un test está mal,
  reporta ROJO y explica por qué, pero no lo edites sin autorización. Los tests
  son el criterio de verificación; editarlos es borrar el criterio.
- **Nunca reportes VERDE sin haber corrido los cinco pasos.**
- Si el mismo test falla tres vueltas seguidas, detente y pide ayuda en vez de
  seguir intentando. Tres fallos iguales significan que falta información,
  no que falte otro intento.
