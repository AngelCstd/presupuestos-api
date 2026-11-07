/**
 * Override de `BigInt.prototype.toJSON` (ARCHITECTURE.md §3.11/§4) —
 * efecto de solo importar el módulo. Debe registrarse antes de
 * instanciar cualquier filtro/provider en el bootstrap real de la app;
 * aquí solo vive la definición, U23.
 */
declare global {
  interface BigInt {
    toJSON(): string;
  }
}

BigInt.prototype.toJSON = function (this: bigint): string {
  return this.toString();
};

/**
 * Serializador defensivo para `metadata` antes de escribir a `ErrorLog`
 * (ARCHITECTURE.md §4/C4): cualquier valor no convertible a JSON se
 * reemplaza por un string legible, en vez de lanzar. `BigInt` ya queda
 * cubierto por el override de arriba — esto cubre lo que sigue sin ser
 * serializable después de eso: funciones, símbolos y referencias
 * circulares.
 */
export function sanitizeMetadata(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === 'function') {
    return '[no serializable: function]';
  }
  if (typeof value === 'symbol') {
    return '[no serializable: symbol]';
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (seen.has(value)) {
    return '[no serializable: circular]';
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeMetadata(item, seen));
  }

  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    result[key] = sanitizeMetadata(val, seen);
  }
  return result;
}
