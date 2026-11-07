/** TASK-api.md §5.2 — paginación por offset, usada por todos los listados salvo ledger. */
export interface OffsetPage {
  page: number;
  pageSize: number;
}

export interface Paged<T> {
  data: T[];
  page: number;
  pageSize: number;
  total: number;
}
