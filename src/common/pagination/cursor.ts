import { InvalidCursorException } from '../errors/invalid-cursor.exception';

/** TASK-api.md §5.2 — cursor opaco: base64url(JSON.stringify({b, t, e?})). */
export interface Cursor {
  /** `bookedAt`, YYYY-MM-DD */
  b: string;
  /** `transaction_id` */
  t: string;
  /** `entry_id`, solo en los dos endpoints de ledger */
  e?: string;
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf-8').toString('base64url');
}

export function decodeCursor(raw: string): Cursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf-8'));
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as Cursor).b !== 'string' ||
      typeof (parsed as Cursor).t !== 'string'
    ) {
      throw new Error('forma de cursor inválida');
    }
    return parsed as Cursor;
  } catch {
    throw new InvalidCursorException();
  }
}
