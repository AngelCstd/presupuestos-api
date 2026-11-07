// TASK-auth.md, Entregables: "Override de BigInt.prototype.toJSON,
// registrado en la primera línea del bootstrap (main.ts), antes de
// instanciar cualquier filtro/provider." DEBE ser el primer import de
// main.ts, antes de cualquier otro — si se registra después de
// instanciar GlobalExceptionFilter, queda una ventana donde el primer
// error cuyo contexto incluya un BigInt truena el propio manejador de
// errores: el cliente recibe un 500 crudo, sin log, sin rastro de qué
// pasó.
//
// Reexporta el efecto secundario ya implementado y probado (Grupo M,
// T-M03/T-M04 en test/unit/money.spec.ts) en
// src/shared/money/bigint-serializer.ts, en vez de duplicar la
// asignación a BigInt.prototype.toJSON aquí — misma razón que
// src/common/logging/error-log-serializer.ts: dos copias de la misma
// asignación global solo pueden divergir, nunca ayudar.
//
// ⚠️ Advertencia verificada en esta sesión (ver PROGRESS.md): un import
// de SOLO EFECTO SECUNDARIO (`import 'ruta'`, sin bindings) a un módulo
// que no existe NO genera TS2307 — la compilación pasa en silencio. Si
// este archivo se borra, o la ruta con la que se importa en main.ts se
// escribe mal, nada avisa en build ni en tests: el único síntoma es un
// 500 crudo sin log la primera vez que un error trae un BigInt en su
// contexto. Ningún test cubre este archivo directamente — el único
// resguardo real es que exista y sea el primer import de main.ts.
import '../../shared/money/bigint-serializer';
