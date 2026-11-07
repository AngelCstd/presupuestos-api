/**
 * Fecha del próximo recordatorio recurrente (ARCHITECTURE.md §3.3, U08b).
 *
 * Regla: se aplica `dayOfMonth` al mes calendario donde debe caer el
 * próximo ciclo — el mismo mes de `lastConfirmedOn` si ese día todavía no
 * se alcanzó dentro de él (`confirmedDay < dayOfMonth`), o el mes
 * siguiente si ya se alcanzó o pasó (`confirmedDay >= dayOfMonth`). Esto
 * es lo que evita el corrimiento acumulado: confirmar el 1 de marzo un
 * recordatorio de día 31 vuelve a dar 31 de marzo (el día 31 de marzo
 * todavía no pasó), no abril.
 *
 * Si `dayOfMonth` no existe en el mes objetivo, el resultado es el
 * primer día del mes siguiente a ese mes objetivo.
 */
export function nextDueOn(dayOfMonth: number, lastConfirmedOn: Date): Date {
  const confirmedDay = lastConfirmedOn.getUTCDate();
  const confirmedMonth = lastConfirmedOn.getUTCMonth();
  const confirmedYear = lastConfirmedOn.getUTCFullYear();

  let targetMonth = confirmedMonth;
  let targetYear = confirmedYear;
  if (confirmedDay >= dayOfMonth) {
    targetMonth += 1;
    if (targetMonth > 11) {
      targetMonth = 0;
      targetYear += 1;
    }
  }

  const daysInTargetMonth = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();

  if (dayOfMonth > daysInTargetMonth) {
    const overflowMonth = targetMonth === 11 ? 0 : targetMonth + 1;
    const overflowYear = targetMonth === 11 ? targetYear + 1 : targetYear;
    return new Date(Date.UTC(overflowYear, overflowMonth, 1));
  }

  return new Date(Date.UTC(targetYear, targetMonth, dayOfMonth));
}
