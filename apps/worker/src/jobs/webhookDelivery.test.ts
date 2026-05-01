import { describe, expect, it } from 'vitest';
import { webhookDeliveryBackoffStrategy } from './webhookDelivery.js';

describe('webhookDeliveryBackoffStrategy', () => {
  it('returns the staircase schedule for the first 7 retries', () => {
    // attemptsMade is 1-indexed (the count of failures so far). The
    // returned ms is the delay before the *next* attempt.
    expect(webhookDeliveryBackoffStrategy(1)).toBe(30_000);
    expect(webhookDeliveryBackoffStrategy(2)).toBe(60_000);
    expect(webhookDeliveryBackoffStrategy(3)).toBe(5 * 60_000);
    expect(webhookDeliveryBackoffStrategy(4)).toBe(15 * 60_000);
    expect(webhookDeliveryBackoffStrategy(5)).toBe(30 * 60_000);
    expect(webhookDeliveryBackoffStrategy(6)).toBe(60 * 60_000);
    expect(webhookDeliveryBackoffStrategy(7)).toBe(2 * 60 * 60_000);
  });

  it('clamps to the last entry past the schedule length', () => {
    expect(webhookDeliveryBackoffStrategy(20)).toBe(2 * 60 * 60_000);
  });

  it('handles zero/negative attemptsMade defensively', () => {
    expect(webhookDeliveryBackoffStrategy(0)).toBe(30_000);
    expect(webhookDeliveryBackoffStrategy(-5)).toBe(30_000);
  });

  it('total worst-case delay across 7 retries stays under 5 hours', () => {
    let total = 0;
    for (let i = 1; i <= 7; i++) total += webhookDeliveryBackoffStrategy(i);
    // Schedule sums to 30s+1m+5m+15m+30m+1h+2h ≈ 3h45m
    expect(total).toBeLessThan(5 * 60 * 60_000);
    expect(total).toBeGreaterThan(3 * 60 * 60_000);
  });
});
