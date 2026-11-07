# Hallazgos de la primera pasada de uso real

> Domingo 1 nov 2026, ~1:17 PM. Stack local, datos sembrados.
> Clasificado desde el relato de Luis. Nada aquí es una decisión tomada todavía.
>
> ⚠️ **Esto es un registro, no una orden de trabajo.** Ningún punto de este documento se
> implementa hasta que Luis lo pida explícitamente, por tandas. Si estás leyendo esto
> buscando qué hacer, la respuesta es: nada, hasta que te lo digan.
>
> Conforme se cierren, marca cada punto con la vuelta en que se resolvió. Este archivo es
> la lista viva.

---

## El patrón de fondo

Seis hallazgos distintos son el mismo problema: **la app muestra totales y no deja entrar
en ellos.** Cada número resumen debería poder tocarse y llevar a lo que lo compone.

Afecta a: el banner del movimiento sin periodo · los $2,570.50 gastados del periodo ·
"Por asignar" · "Total en mano" · el sobregiro de Salud · el periodo abierto.

Resolverlo de una vez vale más que siete arreglos sueltos.

---

## ROTO

| # | Qué pasó | Dónde | Estado |
|---|---|---|---|
| R1 | El modal de confirmar un recordatorio **no tiene botón de cancelar**. Si entras por accidente, te obliga a reiniciar | `/recordatorios` | ✅ Resuelto (Vuelta 1) |
| R2 | El gasto creado desde un recordatorio **aparece hasta abajo** en el historial, no arriba. El orden no refleja cuándo se creó el cargo | `/movimientos` | ✅ Resuelto (Vuelta 1) |
| R3 | "Cubrir" desde Inicio manda a `/sobres` y ahí se acaba el camino. Debería abrir directo la hoja de cubrir de ese sobre | `/` → `/sobres` | ✅ Resuelto (Vuelta 1) |

---

## CONFUSO

| # | Qué pasó | Dónde | Estado |
|---|---|---|---|
| C1 | **La barra azul no dice qué mide** — ¿es lo gastado o lo que queda? | `CategoryCard`, Inicio y `/sobres` | ✅ Resuelto (Vuelta 3) |
| C2 | El input con "600" y el botón "Guardar" al lado del sobre: no se entiende para qué son | `/sobres` | ✅ Resuelto (Vuelta 3) |
| C3 | "Agotado" no se entiende como estado | `CategoryCard` | ✅ Resuelto (Vuelta 3) |
| C4 | El banner dice que un movimiento no cae en ningún periodo, pero **no dice cuál ni cómo arreglarlo** | `/` y `/movimientos` | ✅ Resuelto (Vuelta 2) |
| C5 | Dice "gastaste $2,570.50 este periodo" y **no hay forma de ver esos gastos** | `/` | ✅ Resuelto (Vuelta 2) |
| C6 | "Por asignar" parece correcto pero **no se sabe de dónde sale ese dinero** | `/` | ✅ Resuelto (Vuelta 2) |
| C7 | **"Total en mano"** no se entiende. Luis dedujo que era efectivo − deuda, dudó si incluía lo que le deben, y concluyó que la etiqueta está mal | `/cuentas` | ✅ Resuelto (Vuelta 2) |
| C8 | En Movimientos hay un movimiento marcado como corregido y **no se sabe cuál es, dónde está, ni qué hacer con él** | `/movimientos` | ✅ Resuelto (Vuelta 2) |
| C9 | Falta señalización general para alguien que entra sin saber qué está viendo | toda la app | ✅ Resuelto (Vuelta 4) |

---

## FALTA

| # | Qué se pidió | Dónde | Estado |
|---|---|---|---|
| F1 | **Detalle de sobre**: cuándo asigné, cuándo gasté. La ruta existe pero no se llega a ella | `/sobres/[id]` | ✅ Resuelto (Vuelta 2) |
| F2 | **Ver el periodo abierto**: hoy solo se puede cerrar. No se puede entrar a ver qué se cargó en él | `/periodos` | ✅ Resuelto (Vuelta 2) |
| F3 | **Cuánto llevo asignado / cuánto me falta**, arriba en la pantalla de sobres | `/sobres` | ✅ Resuelto (Vuelta 3) |
| F4 | Un acceso directo en cada sobre para mover dinero sin dar vueltas | `/sobres` | ✅ Resuelto (Vuelta 3) |
| F5 | En el detalle de cuenta, **acotar los movimientos** al último mes o quincena | `/cuentas/[id]` | |
| F6 | Al confirmar un recordatorio, **ver a qué sobre y a qué cuenta va** antes de confirmar | `/recordatorios` | ✅ Resuelto (Vuelta 1) |
| F7 | Guardar y mostrar **la hora en que se creó el cargo**, no solo la fecha contable | `/movimientos` | ✅ Resuelto (Vuelta 1) |

---

## FEO / IDEAS

| # | Qué | Dónde | Estado |
|---|---|---|---|
| E1 | La tarjeta alrededor del input de monto sobra; con el input basta | `/capturar/gasto` | ✅ Resuelto (Vuelta 4) |
| E2 | El `select` de sobre es lento. Propuesta: pastillas táctiles con regla estable (último usado primero + alfabético) | `/capturar/gasto` | ✅ Resuelto (Vuelta 4) |
| E3 | Íconos en el menú de navegación | TabBar | ✅ Resuelto (Vuelta 4) |
| E4 | Alguna gráfica o indicador de avance (marcador de ritmo factual en PeriodHeader) | `/` | ✅ Resuelto (Vuelta 4) |
| E5 | La zona horaria no tiene que estar siempre visible; va en una sección de configuración | `/mas` | ✅ Resuelto (Vuelta 4) |

---

## DECISIONES DE PRODUCTO (de Luis, no del agente)

1. **Periodos mensuales en vez de quincenales.** La API acepta cualquier rango — "quincena"
   fue solo el default. Decisión pendiente: ¿se adopta el mes como periodo normal?
2. **Qué etiqueta lleva el número de `/cuentas`.** "Total en mano" no funcionó. Segunda
   vuelta sobre lo mismo: la etiqueta tiene que decir qué es sin prometer que se puede
   gastar.
3. **"Por asignar" cuando traes saldo en tarjeta** — la decisión aparcada desde hace
   semanas, todavía sin resolver.

---

## Lo que funcionó

- `/cuentas` le gustó: "es una buena pantalla, dejémosla ahí".
- Los recordatorios: confirmar crea el gasto directo, y modificar el monto antes de
  confirmar funcionó bien.
- Cubrir un sobregiro desde `/sobres` funcionó: movió dinero de Ahorro a Salud y quedó
  saldado.

---

## DEUDA TÉCNICA DE BACKEND (Aparcada)

Capacidades que el frontend requiere para cerrar completamente el patrón de desglose y auditoría, pero cuyo backend permanece cerrado por ahora:

1. **Bitácora de asignaciones por sobre (`GET /allocations?categoryId=...`)**:
   El detalle de sobre (`/sobres/[id]`) muestra movimientos y saldo actual, pero no el historial cronológico de cambios a la asignación porque el backend no expone un endpoint de auditoría de asignaciones por sobre.
2. **Historial de confirmaciones de recordatorios pasados**:
   El backend no guarda el vínculo entre la regla recurrente y las transacciones creadas al confirmarla (`recurring_entry_id` o similar en ledger), por lo que no se puede listar directamente "pagos confirmados de este recordatorio".
3. **Filtros de fecha `from` y `to` en `GET /accounts/:id/entries`**:
   El detalle de cuenta lista movimientos paginados pero no acepta acotar por fechas, impidiendo filtrar por mes o quincena sin traer la paginación completa.
4. **`fn_category_balances` carece de `ORDER BY`**:
   La función SQL (`prisma/migrations/20260806014930_05b_fn_category_balances/migration.sql`) consulta `accounts a WHERE a.type = 'expense'` sin cláusula `ORDER BY`. El orden que devuelve la API es el orden físico de las filas en disco de PostgreSQL y puede mutar automáticamente tras operaciones de `UPDATE`. El backend debería traer su propio `ORDER BY` explícito y determinista (`a.name ASC, a.id ASC`).
5. **Iconos y colores persistidos en categorías (`accounts.icon`, `accounts.color`)**:
   El modelo `Account` de la base de datos (`accounts`) no incluye columnas para `icon` o `color`. Para que los sobres tengan personalización persistente y coherente en toda la app sin recurrir a heurísticas de frontend o nombres predefinidos frágiles, el backend requiere migrar la tabla para admitir campos opcionales `icon VARCHAR(50)` y `color VARCHAR(20)`.

