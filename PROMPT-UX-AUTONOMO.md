# Loop de UX — orquestador autónomo

> Para **Claude Code, con el repo del frontend abierto**. Corre la fase de UX completa,
> pantalla por pantalla, sin que yo tenga que estar encima. Se detiene solo en los puntos
> marcados en la §4, que son pocos y están ahí a propósito.

Lee `BRIEF-UX.md`, `SCREENS-front.md`, `ARCHITECTURE-front.md` y `API-CONTRACT.md`
completos antes de nada. La **§8 del `BRIEF-UX.md` es vinculante** en todo el loop.

---

## 0. Inventario — lo primero, y bloquea todo lo demás

**No conoces este repo y no vas a suponer qué hay en él.** Antes de invocar a ningún
agente, escribe `INVENTARIO.md` en la raíz, con lo que **verificaste leyendo archivos**:

| Sección | Qué listar |
|---|---|
| Componentes | Ruta real y props de cada componente reutilizable que exista hoy |
| Tokens | Nombres de token ya declarados, y cuáles no tienen valor todavía |
| i18n | Las claves que ya viven en `lib/i18n/es.ts` |
| Primitivas de dominio | Las funciones de `lib/domain/` con su firma real |
| Hooks de datos | Qué hook pide cada endpoint y con qué query key |
| Tests existentes | Qué archivo cubre qué. **Estos no se tocan en todo el loop** |

**Regla que gobierna el resto del loop:** cualquier afirmación sobre un componente, un
token, una clave de i18n o una capacidad de la API tiene que salir del `INVENTARIO.md` o de
los cuatro documentos, con su ruta o su sección. **Si no está ahí, no existe.** Un
componente que "debería existir" se crea o se propone, nunca se importa.

Esto no es burocracia: una corrida anterior de este mismo trabajo citó cuatro rutas de
componentes que nunca leyó. Eso en código es un build roto, y en un loop autónomo son
vueltas perdidas persiguiendo un fantasma.

---

## 1. La cola de pantallas

En este orden, una a la vez, sin saltos:

1. **`/` Inicio** — el peor problema del producto vive aquí
2. **Tarjeta de sobre** — componente, no pantalla; se reutiliza en Inicio y en `/sobres`
3. **`/capturar/gasto`** — el 90% del uso
4. **`/sobres`**  ya con la tarjeta resuelta
5. **`/quincenas/[id]/cerrar`** — la más delicada; se llega con el vocabulario ya hecho
6. **`/movimientos`**, **`/cuentas`**, **`/mas`**, **`/recordatorios`** — las sencillas, al final

Los **tokens** (paleta, escala tipográfica, espaciado, radios) salen una sola vez, después
de 1 y 2. Antes de eso sería adivinar qué tiene que distinguir el color.

---

## 2. El ciclo por pantalla

### 2.1 Council

Invoca a los agentes del `PROMPT-COUNCIL-UX.md`, con su protocolo.

**Cuántos:** los seis completos solo para las pantallas 1, 3 y 5 de la cola. Para el resto,
Product Thinker y UX Expert se fusionan y el UI Expert trabaja con el Critical Thinker;
tres agentes, no seis. Di en una línea cuántos invocaste y por qué.

**El Technical Context Reviewer trabaja contra el `INVENTARIO.md` y el repo**, no contra su
intuición. Si una propuesta necesita un dato que el `API-CONTRACT.md` no tiene, la
propuesta queda bloqueada con el dato exacto que le falta — no se inventa un endpoint.

Entregable: las cinco secciones del formato, en `ux/<pantalla>/council.md`.

### 2.2 Decisiones

Del resultado del Council, separa en dos listas:

- **Mecánicas** — jerarquía, agrupación, qué se colapsa, qué componente se reutiliza,
  dónde va un botón. **Decides tú y sigues.** Dejas el porqué escrito.
- **De producto** — las que cambian qué significa algo para el usuario, o que una vez en
  código son caras de revertir. **Esas van a la §4.**

Si dudas de qué lista es: si el usuario notaría un cambio de *significado*, es de producto.
Si solo notaría un cambio de *forma*, es mecánica.

### 2.3 Implementación

Cambio chico, verificación, siguiente. Nunca tres cambios juntos.

- Todo texto de usuario pasa por `lib/i18n/es.ts`. Ningún string literal en un componente.
- Todo valor visual sale de un token. Cero hex sueltos.
- Los componentes se reutilizan según el `INVENTARIO.md`. Si creas uno nuevo, lo agregas al
  inventario en el mismo commit.
- **No toques `lib/domain/`** ni sus tests. La lógica de montos, fechas y estados de sobre
  ya está cubierta y es correcta.

### 2.4 Verificación

Corre la compuerta completa de la §3. Si algo sale rojo, arréglalo antes de pasar a la
siguiente pantalla. **Rojo no avanza.**

Después, con capturas en mano, escribe tu propia evaluación contra las tres pruebas del §2
del `BRIEF-UX.md` — una línea por prueba, con el veredicto y por qué. Si una no pasa, no
terminaste.

---

## 3. La compuerta — la parte que no opina

Esto es binario. Ejecútalo entero al cerrar cada pantalla y pega el resultado en
`PROGRESS-UX.md`.

| # | Verificación | Pasa si |
|---|---|---|
| G1 | `tsc --noEmit` | Cero errores |
| G2 | La suite existente | Verde, y **sin un solo archivo de test modificado** (`git diff --stat` sobre los tests debe salir vacío) |
| G3 | Build de producción | Compila |
| G4 | Cero valores crudos o arbitrarios en `src/` | 1) Cero hex fuera de tokens (`grep -rE '#[0-9a-fA-F]{3,8}' src/`). 2) Cero clases arbitrarias de Tailwind con corchetes (`grep -rnE '[a-z0-9-]+-\[[^\]]+\]' src/ --include=*.tsx --include=*.ts`). Todo valor visual debe provenir de tokens o escala estándar. |
| G5 | Strings de usuario fuera de `lib/i18n/` | Cero. Revisa los `.tsx` que tocaste en esta pantalla |
| G6 | Vocabulario prohibido en `lib/i18n/es.ts` y componentes | Cero: `movimiento contable`, `asiento`, `partida doble`, `entry`, `ledger`, `rollover`, `overspent`, `no_budget`, y kinds/enums de la API: `cash`, `credit`, `receivable`, `category`, `income_source`, `in_open_period`, `compensated`, `uncompensated`, `no_period`, `accumulate`, `reset`, `carry_forward`, `release`, `carry_deficit` |
| G7 | Llamadas de red de la pantalla | Las declaradas en su brief, ni una más |
| G8 | Ausencia de desborde y capturas (360px, 390px, 768px) | Con el viewport fijado en el navegador a cada ancho, pasa la aserción mecánica: `document.documentElement.scrollWidth <= window.innerWidth`. Se reporta el valor de `innerWidth` y `scrollWidth` de cada corrida (rojo si falla). Las capturas en `ux/<pantalla>/` existen para revisión de Luis. |
| G9 | Imports | Todo lo importado existe en el `INVENTARIO.md` o lo creaste en esta corrida |
| G10 | Despeje inferior mecánico frente a elementos fijos (360px, 390px, 768px) | A cada uno de los tres anchos: scroll hasta el fondo, toma el último elemento de contenido de la vista y la barra fija (contando el botón central que sobresale), y asegura que `ultimoElemento.getBoundingClientRect().bottom <= tabBar.getBoundingClientRect().top`. Se reportan los dos valores de cada corrida (rojo si falla). |
| G11 | Referencias internas en texto de usuario | Cero coincidencias en strings visibles al usuario (en `lib/i18n/es.ts` y `.tsx`): `.md`, `§`, `ARCHITECTURE`, `API-CONTRACT`, `SCREENS`, `TASK-`, `INVENTARIO`. Reglas técnicas van en comentarios de código, nunca en pantalla. |

G2 es la más importante: esos tests son lo único que impide que una mejora visual rompa la
aritmética del dinero. **Si crees que un test está mal, detente y dímelo.** Editarlo es
borrar el criterio.

---

## 4. Cuándo te detienes

Son pocos. Fuera de estos, avanzas.

**4.1 — Antes de implementar Inicio, una pregunta, una sola.** Hay una decisión abierta y
es la más cara del producto:

> Cuando "Por asignar" sale negativo, ¿el número se muestra en negativo, o se deja en $0.00
> y el déficit se cuenta aparte?

Contexto que ya está verificado y que **no tienes que volver a investigar**: el contrato
define `sin asignar = dinero real − comprometido`, donde *dinero real* = saldo `cash` +
saldo `credit`. Con $1,000 en efectivo, $1,000 asignados a Comida, $600 gastados ahí y $300
en Transporte sin presupuesto, el resultado es **dinero real +$100 con "Por asignar"
−$600**. O sea: un negativo ahí puede convivir con dinero en la mano, y también puede
acompañar a un dinero real negativo. **Son dos situaciones distintas y las dos llegan en la
misma respuesta.**

Lo que no se acepta como respuesta a esto: una condición que dispare solo con
`categories.some(status === 'overspent')`. Con $2,000 por asignar y un sobre sobregirado
por $300, esa condición grita por el caso trivial. Cualquier propuesta tiene que mirar el
dinero real **y** el déficit de sobres, no uno de los dos.

Hazme la pregunta con tus dos o tres opciones y una recomendación. Una pantalla de texto,
no un informe.

**4.2 — Una decisión de producto que no estaba en el brief.** Preséntala y espera. No la
resuelvas por criterio propio.

**4.3 — Una propuesta que necesita un dato que la API no da.** No pidas endpoint nuevo: el
backend está cerrado. Dime qué dato y para qué.

**4.4 — La mejor solución exige violar la §8 del `BRIEF-UX.md`.** Dilo, con el costo de no
violarla. No la violes.

**4.5 — Tres vueltas con el mismo rojo en la compuerta.** Alto. Falta información, no otro
intento.

**4.6 — Un test existente falla y crees que el test está mal.** Alto, siempre.

**Si no estoy, para 4.2 y 4.3:** haz el trabajo que no depende de esa decisión, déjala
escrita en `PROGRESS-UX.md` bajo *Decisiones pendientes* con tus opciones, y sigue con la
siguiente pantalla de la cola. **4.1, 4.4, 4.5 y 4.6 detienen el loop de verdad.**

---

## 5. `PROGRESS-UX.md`

Se actualiza al cerrar cada pantalla. Cinco cosas:

1. **Qué quedó verde** — con el resultado de la compuerta pegado
2. **Qué cambió y por qué** — la tabla B del Council, resumida
3. **Decisiones pendientes** — las de la §4 que quedaron esperándome
4. **Qué aprendiste del repo** que no estaba en los documentos
5. **Qué sigue** — la siguiente de la cola, y qué necesita antes de empezar

El punto 4 es el que más vale: es lo que evita que la siguiente sesión repita el mismo
callejón sin salida. Si descubres que un componente no era reutilizable, que un token
faltaba, o que un hook no invalidaba lo que parecía — ahí va.

---

## 6. Reglas del loop

1. **Una pantalla a la vez.** No abras la siguiente con la anterior en rojo.
2. **Un cambio por vuelta.** Si arreglas tres cosas y sigue rojo, no sabes cuál falló.
3. **Nunca edites un test.** Ni uno.
4. **No toques el backend.** Está cerrado y desplegado.
5. **No modifiques `API-CONTRACT.md`, `ARCHITECTURE-front.md` ni `SCREENS-front.md`.** Si
   algo en ellos quedó desactualizado por tu trabajo, anótalo en `PROGRESS-UX.md` y dímelo.
6. **No inventes componentes, rutas, tokens ni claves de i18n.** `INVENTARIO.md` o nada.
7. **Pago de tarjeta es una transferencia, nunca un gasto.** No se negocia.
8. **No conviertas una pantalla sencilla en un dashboard.**
9. **No resuelvas una acción irreversible con un modal de confirmación.** Un modal es lo que
   se pone cuando no se pensó el problema.
10. **El color nunca es lo único que distingue un estado.**
11. Prioriza por impacto, no por cantidad. Un brief mejor, no uno más largo.
12. **Ninguna verificación que dependa de mirar algo la firmas tú.** Todo aspecto visual (capturas, layout, alineación, jerarquía, renderizado) lo revisa y valida Luis. Tú generas los artefactos y los presentas; nunca los declaras visualmente verificados por ti.

---

## 7. Arranca

1. Escribe el `INVENTARIO.md`. Muéstramelo. **Es lo único que te pido ver antes de que
   empieces a trabajar solo** — si eso está mal, todo lo demás se construye encima del
   error.
2. Corre el Council de Inicio.
3. Hazme la pregunta de la §4.1 junto con el resultado del Council, en el mismo mensaje.
4. Con mi respuesta, implementa Inicio hasta que la compuerta dé verde.
5. Actualiza `PROGRESS-UX.md` y sigue con la tarjeta de sobre, sin preguntarme.

De ahí en adelante no me pidas permiso para avanzar. Avísame cuando una pantalla quede
verde, cuando algo de la §4 te detenga, o cuando termines la cola.
