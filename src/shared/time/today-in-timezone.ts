/**
 * TASK-api.md §5.5 — "La API nunca usa now() de Postgres ni la hora del
 * servidor para decidir a qué periodo pertenece una fecha." "Hoy" del
 * usuario siempre se deriva de `profile.timezone`, nunca de `new Date()`
 * sin zona ni de una consulta a Postgres.
 */
export function todayInTimezone(timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());
}
