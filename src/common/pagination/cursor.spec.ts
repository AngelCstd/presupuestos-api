// TASK-api.md §5.2 — cursor opaco base64url({b, t, e?}). Grupo U
// (T-U17–U18), unit, sin base de datos. `cursor.ts` no existe todavía.
import { encodeCursor, decodeCursor } from './cursor';
import { InvalidCursorException } from '../errors/invalid-cursor.exception';

describe('cursor — encodeCursor / decodeCursor', () => {
  it('T-U17: round-trip de {b, t} es idéntico', () => {
    const original = { b: '2026-08-09', t: '8f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f' };
    const encoded = encodeCursor(original);
    const decoded = decodeCursor(encoded);

    expect(decoded).toEqual(original);
  });

  it('T-U18: decodeCursor de un string no-base64 → InvalidCursorException (INVALID_CURSOR)', () => {
    try {
      decodeCursor('%%%no-base64%%%');
      fail('debía lanzar InvalidCursorException');
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidCursorException);
      expect((e as InvalidCursorException).code).toBe('INVALID_CURSOR');
    }
  });
});
