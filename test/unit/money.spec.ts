import '../../src/shared/money/bigint-serializer';
import { sanitizeMetadata } from '../../src/shared/money/bigint-serializer';
import { splitAmount } from '../../src/shared/money/split';

describe('Grupo M — BigInt (U23, sin DB)', () => {
  it('T-M02 ⭐: JSON.stringify({ n: 10n }) tras el bootstrap no lanza TypeError', () => {
    expect(() => JSON.stringify({ n: 10n })).not.toThrow();
    expect(JSON.stringify({ n: 10n })).toBe('{"n":"10"}');
  });

  it('T-M03 ⭐: metadata con un valor no serializable hacia ErrorLog se persiste con placeholder legible', () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;

    const metadata = {
      amountCents: 70000n,
      callback: () => 'no debería serializarse',
      circular,
    };

    let sanitized: unknown;
    expect(() => {
      sanitized = sanitizeMetadata(metadata);
    }).not.toThrow();

    expect(() => JSON.stringify(sanitized)).not.toThrow();
    const serialized = JSON.stringify(sanitized);
    expect(serialized).toContain('no serializable');
  });

  it('T-M04 ⭐: repartir 100 entre 3 da [34, 33, 33] y suma exactamente 100', () => {
    const parts = splitAmount(100, 3);
    expect(parts).toEqual([34, 33, 33]);
    expect(parts.reduce((sum: number, part: number) => sum + part, 0)).toBe(100);
  });

  it('T-M04 ⭐ (caso exacto): repartir 90 entre 3 no deja residuo', () => {
    const parts = splitAmount(90, 3);
    expect(parts).toEqual([30, 30, 30]);
    expect(parts.reduce((sum: number, part: number) => sum + part, 0)).toBe(90);
  });
});
