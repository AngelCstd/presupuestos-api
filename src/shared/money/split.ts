/**
 * Reparte `totalCents` entre `parts` partes enteras — la suma de las
 * partes es siempre exactamente `totalCents` (ARCHITECTURE.md §3.11): el
 * residuo de la división entera se asigna a la primera parte, nunca se
 * descarta (descartarlo desbalancearía la transacción y R1 la rechazaría).
 */
export function splitAmount(totalCents: number, parts: number): number[] {
  const base = Math.floor(totalCents / parts);
  const remainder = totalCents - base * parts;
  const result = new Array<number>(parts).fill(base);
  result[0] += remainder;
  return result;
}
