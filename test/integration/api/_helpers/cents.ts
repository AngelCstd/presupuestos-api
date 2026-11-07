/**
 * Un monto en centavos llega con un tipo distinto según la ruta por la
 * que se lea, y las dos son legítimas — no hay una "correcta":
 *
 * - Por HTTP (`res.body....Cents`): siempre string — pasó por
 *   `BigInt.prototype.toJSON` (TASK-api.md §5.5).
 * - Por SQL directo con el pool compartido (`test/setup/db.ts`): siempre
 *   `number` — ese archivo registra a propósito un parser de OID 20
 *   (bigint) que convierte a `Number`, para que los tests de la capa de
 *   datos puedan comparar `toBe(70000)` sin envolver en string.
 * - Por un repository de Prisma invocado directo (sin pasar por HTTP ni
 *   por el pool de `pg`): `bigint`.
 *
 * Mezclar la aserción con el tipo equivocado no es un error de lógica,
 * es un error de tipo — y ya costó cuatro correcciones en este loop
 * (T-F07, T-I03, T-I09, T-M01/T-M03/T-M04/T-M11). `expectCents` compara
 * por valor, normalizando los tres casos, para que quien escriba el
 * siguiente test no tenga que recordar por cuál ruta vino el dato.
 */
export function expectCents(actual: unknown, expected: number | string | bigint): void {
  expect(normalizeCents(actual)).toBe(normalizeCents(expected));
}

function normalizeCents(value: unknown): string {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value;
  throw new Error(`expectCents: valor de monto inesperado (${typeof value}): ${JSON.stringify(value)}`);
}
