import { canonicalJson } from './canonical-json.js';

const sparse: unknown[] = [];
sparse.length = 2;

describe('Canonical command JSON', () => {
  it('ignores property insertion order and object identity', () => {
    expect(canonicalJson({ itemId: 'x', quantity: 1 })).toBe(
      canonicalJson({ quantity: 1, itemId: 'x' }),
    );
  });
  it('sorts nested objects recursively, including objects inside arrays', () => {
    expect(
      canonicalJson({
        items: [{ quantity: 1, item: { id: 'x', flags: [true, null] } }],
        enabled: true,
      }),
    ).toBe(
      canonicalJson({
        enabled: true,
        items: [{ item: { flags: [true, null], id: 'x' }, quantity: 1 }],
      }),
    );
  });
  it('preserves array order and distinguishes values and scalar types', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
    expect(canonicalJson({ quantity: 1 })).not.toBe(
      canonicalJson({ quantity: 2 }),
    );
    expect(canonicalJson({ quantity: 1 })).not.toBe(
      canonicalJson({ quantity: '1' }),
    );
    expect(canonicalJson({ value: null })).not.toBe(canonicalJson({}));
  });
  it('normalizes equivalent JSON numbers and safely escapes keys/values', () => {
    expect(canonicalJson({ number: -0 })).toBe(canonicalJson({ number: 0 }));
    const data = { 'quote"': 'line\ntext', nested: { '2': 2, '10': 10 } };
    expect(JSON.parse(canonicalJson(data))).toEqual(data);
    expect(canonicalJson(data)).toContain('"10":10,"2":2');
  });
  it('allows repeated references without allowing cycles', () => {
    const shared = { value: 1 };
    expect(canonicalJson([shared, shared])).toBe('[{"value":1},{"value":1}]');
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    expect(() => canonicalJson(cycle)).toThrow('Invalid JSON');
  });
  it.each([
    undefined,
    NaN,
    Infinity,
    1n,
    new Date(),
    { value: undefined },
    sparse,
    {
      toJSON() {
        return 1;
      },
    },
    { [Symbol('key')]: 'value' },
  ])('rejects non-JSON data %#', (value) => {
    expect(() => canonicalJson(value)).toThrow('Invalid JSON');
  });
  it('never invokes getters and rejects excessively large JSON', () => {
    expect(() =>
      canonicalJson({
        get secret() {
          throw new Error('getter invoked');
        },
      }),
    ).toThrow('Invalid JSON');
    expect(() => canonicalJson({ nonce: 'x'.repeat(4090) })).toThrow(
      'size limit',
    );
  });
});
