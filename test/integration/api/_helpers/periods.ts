import { randomUUID } from 'node:crypto';
import { insertPeriod } from '../../../setup/fixture';
import { pool } from './seed';

/**
 * Grupo S (captura tardía) depende de que "hoy" caiga dentro de un periodo
 * ABIERTO real — TASK-api.md §2.3 prohíbe resolver "hoy" con una fecha
 * hardcodeada, y esa prohibición aplica igual de fuerte a cómo sembramos
 * los tests: los `p1`/`p2` del fixture compartido (`test/setup/fixture.ts`)
 * son fijos en agosto 2026, así que solo alinean con "hoy" si la suite
 * corre exactamente esas fechas. Aquí se siembran relativos a la fecha
 * real de ejecución, en la misma zona horaria del perfil
 * ('America/Mexico_City'), para que el escenario sea válido sin importar
 * cuándo se corra la suite.
 */
export function todayInMexicoCity(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date());
}

export function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export interface LateCapturePeriods {
  today: string;
  /** Cerrado: [hoy−30, hoy−1]. */
  closedPeriodId: string;
  closedStartsOn: string;
  closedEndsOn: string;
  /** Abierto: [hoy, hoy+29] — cubre "hoy" siempre. */
  openPeriodId: string;
  openStartsOn: string;
  openEndsOn: string;
  /** Cae dentro del periodo cerrado — para bookedAt de captura tardía. */
  bookedAtInClosedPeriod: string;
  /** No cae en ningún periodo de los dos anteriores — para T-S15. */
  bookedAtInGap: string;
}

/**
 * Siembra P1 (cerrado) + P2 (abierto) relativos a "hoy", para un usuario ya
 * existente. `seedFixtureCommitted()` ya le insertó su propio `p1`/`p2` fijo
 * (agosto 2026, `test/setup/fixture.ts`) — si "hoy" cae cerca de esas
 * fechas (como al escribir esta suite), el rango dinámico de abajo las
 * traslapa y `budget_periods_no_overlap` (EXCLUDE, WHERE deleted_at IS
 * NULL) rechaza el INSERT. Se soft-borran esos dos primero: son del mismo
 * usuario recién creado para este archivo, no tocan a nadie más.
 */
export async function seedLateCapturePeriods(userId: string): Promise<LateCapturePeriods> {
  const today = todayInMexicoCity();
  const closedStartsOn = addDays(today, -30);
  const closedEndsOn = addDays(today, -1);
  const openStartsOn = today;
  const openEndsOn = addDays(today, 29);

  const closedPeriodId = randomUUID();
  const openPeriodId = randomUUID();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE budget_periods SET deleted_at = now() WHERE user_id = $1 AND deleted_at IS NULL', [
      userId,
    ]);
    await insertPeriod(client, {
      id: closedPeriodId,
      userId,
      startsOn: closedStartsOn,
      endsOn: closedEndsOn,
      closedAt: new Date().toISOString(),
    });
    await insertPeriod(client, {
      id: openPeriodId,
      userId,
      startsOn: openStartsOn,
      endsOn: openEndsOn,
    });
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  return {
    today,
    closedPeriodId,
    closedStartsOn,
    closedEndsOn,
    openPeriodId,
    openStartsOn,
    openEndsOn,
    bookedAtInClosedPeriod: addDays(today, -5),
    bookedAtInGap: addDays(today, -60),
  };
}
