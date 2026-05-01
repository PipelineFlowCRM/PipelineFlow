import { describe, expect, it } from 'vitest';
import { fingerprintArgs } from './approval.js';

describe('fingerprintArgs', () => {
  it('is stable across key reordering', () => {
    const a = fingerprintArgs({ id: 1, name: 'x', meta: { a: 1, b: 2 } });
    const b = fingerprintArgs({ name: 'x', id: 1, meta: { b: 2, a: 1 } });
    expect(a).toBe(b);
  });

  it('differs for different values', () => {
    expect(fingerprintArgs({ id: 1 })).not.toBe(fingerprintArgs({ id: 2 }));
    expect(fingerprintArgs({ id: 1 })).not.toBe(fingerprintArgs({ id: '1' }));
  });

  it('differs when keys differ', () => {
    expect(fingerprintArgs({ id: 1 })).not.toBe(fingerprintArgs({ ID: 1 }));
  });

  it('handles arrays and nested structures', () => {
    const a = fingerprintArgs({ tags: [1, 2, 3], filters: { q: 'foo' } });
    const b = fingerprintArgs({ filters: { q: 'foo' }, tags: [1, 2, 3] });
    expect(a).toBe(b);
    const reorderedArray = fingerprintArgs({ tags: [3, 2, 1], filters: { q: 'foo' } });
    // Arrays are order-sensitive — that's intentional, [1,2,3] and
    // [3,2,1] are semantically different inputs.
    expect(a).not.toBe(reorderedArray);
  });

  it('handles primitives and null', () => {
    expect(fingerprintArgs(null)).toBe(fingerprintArgs(null));
    expect(fingerprintArgs(null)).not.toBe(fingerprintArgs(undefined));
    expect(fingerprintArgs(true)).not.toBe(fingerprintArgs(false));
  });
});
