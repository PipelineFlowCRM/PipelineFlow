import { describe, expect, it } from 'vitest';
import { computeDestinationOrder } from './boardOrder.js';

describe('computeDestinationOrder', () => {
  it('inserts at the top (position 0)', () => {
    const r = computeDestinationOrder([10, 20, 30], 99, 0);
    expect(r.targetIndex).toBe(0);
    expect(r.orderedIds).toEqual([99, 10, 20, 30]);
  });

  it('inserts in the middle', () => {
    const r = computeDestinationOrder([10, 20, 30], 99, 2);
    expect(r.targetIndex).toBe(2);
    expect(r.orderedIds).toEqual([10, 20, 99, 30]);
  });

  it('appends at the end (position == length)', () => {
    const r = computeDestinationOrder([10, 20, 30], 99, 3);
    expect(r.targetIndex).toBe(3);
    expect(r.orderedIds).toEqual([10, 20, 30, 99]);
  });

  it('clamps position above length to the end', () => {
    const r = computeDestinationOrder([10, 20, 30], 99, 9999);
    expect(r.targetIndex).toBe(3);
    expect(r.orderedIds).toEqual([10, 20, 30, 99]);
  });

  it('clamps negative position to the top', () => {
    const r = computeDestinationOrder([10, 20, 30], 99, -5);
    expect(r.targetIndex).toBe(0);
    expect(r.orderedIds).toEqual([99, 10, 20, 30]);
  });

  it('handles an empty destination stage', () => {
    const r = computeDestinationOrder([], 99, 0);
    expect(r.targetIndex).toBe(0);
    expect(r.orderedIds).toEqual([99]);
  });

  it('clamps for empty destination stage when position > 0', () => {
    const r = computeDestinationOrder([], 99, 5);
    expect(r.targetIndex).toBe(0);
    expect(r.orderedIds).toEqual([99]);
  });

  it('produces 0..n-1 boardOrder when applied with index assignment', () => {
    // Simulates how the move handler renumbers: for each (i, dealId) in
    // orderedIds, write boardOrder = i. Result should be a clean compact
    // sequence with the moving deal at the requested index.
    const r = computeDestinationOrder([10, 20, 30, 40], 99, 2);
    const renumbered = r.orderedIds.map((id, i) => ({ id, boardOrder: i }));
    expect(renumbered).toEqual([
      { id: 10, boardOrder: 0 },
      { id: 20, boardOrder: 1 },
      { id: 99, boardOrder: 2 },
      { id: 30, boardOrder: 3 },
      { id: 40, boardOrder: 4 },
    ]);
  });

  it('places the moving deal at targetIndex within orderedIds', () => {
    // Invariant the move handler relies on: orderedIds[targetIndex] === movingId.
    for (const pos of [0, 1, 2, 3, 4]) {
      const r = computeDestinationOrder([10, 20, 30, 40], 99, pos);
      expect(r.orderedIds[r.targetIndex]).toBe(99);
    }
  });

  it('does not duplicate or drop existing ids regardless of position', () => {
    const dest = [10, 20, 30, 40];
    for (const pos of [-1, 0, 1, 2, 3, 4, 100]) {
      const r = computeDestinationOrder(dest, 99, pos);
      expect(r.orderedIds).toHaveLength(dest.length + 1);
      expect(new Set(r.orderedIds).size).toBe(dest.length + 1);
      // Existing order is preserved among non-moving ids.
      expect(r.orderedIds.filter((x) => x !== 99)).toEqual(dest);
    }
  });
});
