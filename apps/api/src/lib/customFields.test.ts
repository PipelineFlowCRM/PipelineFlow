import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { coerceValue, valueFromRow } from './customFields.js';
import { HttpError } from './error.js';

// Synthetic field def helper — only the fields coerceValue touches.
const def = (
  type: Parameters<typeof coerceValue>[0]['type'],
  options: unknown = null,
  key = 'f',
) => ({ key, type, options });

const selectOpts = {
  choices: [
    { value: 'a', label: 'A' },
    { value: 'b', label: 'B' },
  ],
};

describe('coerceValue', () => {
  describe('TEXT', () => {
    it('round-trips a non-empty string', () => {
      expect(coerceValue(def('TEXT'), 'hello')?.valueText).toBe('hello');
    });
    it('trims whitespace', () => {
      expect(coerceValue(def('TEXT'), '  hi  ')?.valueText).toBe('hi');
    });
    it('returns null for nullish input', () => {
      expect(coerceValue(def('TEXT'), null)).toBeNull();
      expect(coerceValue(def('TEXT'), undefined)).toBeNull();
      expect(coerceValue(def('TEXT'), '')).toBeNull();
      expect(coerceValue(def('TEXT'), '   ')).toBeNull();
    });
    it('rejects non-strings', () => {
      expect(() => coerceValue(def('TEXT'), 42 as unknown as string)).toThrow(HttpError);
    });
    it('enforces 500-char cap', () => {
      expect(() => coerceValue(def('TEXT'), 'x'.repeat(501))).toThrow(/too long/);
      expect(coerceValue(def('TEXT'), 'x'.repeat(500))?.valueText).toHaveLength(500);
    });
  });

  describe('LONG_TEXT', () => {
    it('allows up to 10k chars', () => {
      expect(coerceValue(def('LONG_TEXT'), 'a'.repeat(10_000))?.valueText).toHaveLength(10_000);
    });
    it('rejects 10001+', () => {
      expect(() => coerceValue(def('LONG_TEXT'), 'a'.repeat(10_001))).toThrow(/too long/);
    });
  });

  describe('EMAIL', () => {
    it('accepts a well-formed address', () => {
      expect(coerceValue(def('EMAIL'), 'a@b.co')?.valueText).toBe('a@b.co');
    });
    it.each(['nope', 'a@', '@b', 'a@b', 'no spaces@b.co'])(
      'rejects %j',
      (bad) => expect(() => coerceValue(def('EMAIL'), bad)).toThrow(/invalid email/),
    );
  });

  describe('URL', () => {
    it.each(['http://x', 'https://example.com/path?q=1'])('accepts %j', (s) => {
      expect(coerceValue(def('URL'), s)?.valueText).toBe(s);
    });
    it.each(['ftp://x', 'example.com', 'not a url'])('rejects %j', (bad) => {
      expect(() => coerceValue(def('URL'), bad)).toThrow(/http\(s\)/);
    });
  });

  describe('PHONE', () => {
    it('round-trips', () => {
      expect(coerceValue(def('PHONE'), '+1 555 0100')?.valueText).toBe('+1 555 0100');
    });
    it('rejects > 40 chars', () => {
      expect(() => coerceValue(def('PHONE'), '1'.repeat(41))).toThrow(/too long/);
    });
  });

  describe('NUMBER / MONEY', () => {
    it('coerces strings to Decimal', () => {
      const cols = coerceValue(def('NUMBER'), '12.5');
      expect(cols?.valueNumber).toBeInstanceOf(Prisma.Decimal);
      expect(cols?.valueNumber?.toNumber()).toBe(12.5);
    });
    it('passes through numbers', () => {
      expect(coerceValue(def('MONEY'), 99.99)?.valueNumber?.toNumber()).toBe(99.99);
    });
    it('rejects non-numeric input', () => {
      expect(() => coerceValue(def('NUMBER'), 'abc')).toThrow(/must be a number/);
      expect(() => coerceValue(def('MONEY'), {} as unknown as number)).toThrow(/must be a number/);
    });
    it('returns null for nullish', () => {
      expect(coerceValue(def('NUMBER'), null)).toBeNull();
      expect(coerceValue(def('NUMBER'), '')).toBeNull();
    });
    it('coerces 0 to a real value, not nullish', () => {
      expect(coerceValue(def('NUMBER'), 0)?.valueNumber?.toNumber()).toBe(0);
    });
  });

  describe('DATE', () => {
    it('parses YYYY-MM-DD as UTC midnight', () => {
      const cols = coerceValue(def('DATE'), '2026-04-30');
      expect(cols?.valueDate?.toISOString()).toBe('2026-04-30T00:00:00.000Z');
    });
    it.each(['2026/04/30', '04-30-2026', 'tomorrow', '2026-4-30'])(
      'rejects %j',
      (bad) => expect(() => coerceValue(def('DATE'), bad)).toThrow(/YYYY-MM-DD/),
    );
  });

  describe('BOOLEAN', () => {
    it('preserves false as a real value', () => {
      expect(coerceValue(def('BOOLEAN'), false)?.valueBool).toBe(false);
    });
    it('preserves true', () => {
      expect(coerceValue(def('BOOLEAN'), true)?.valueBool).toBe(true);
    });
    it('treats null/undefined as clear', () => {
      expect(coerceValue(def('BOOLEAN'), null)).toBeNull();
      expect(coerceValue(def('BOOLEAN'), undefined)).toBeNull();
    });
    it('rejects strings', () => {
      expect(() => coerceValue(def('BOOLEAN'), 'true' as unknown as boolean)).toThrow(
        /must be a boolean/,
      );
    });
  });

  describe('SELECT', () => {
    it('accepts an allowed value', () => {
      expect(coerceValue(def('SELECT', selectOpts), 'a')?.valueText).toBe('a');
    });
    it('rejects an unlisted value', () => {
      expect(() => coerceValue(def('SELECT', selectOpts), 'c')).toThrow(/not in allowed/);
    });
    it('rejects when no choices configured', () => {
      expect(() => coerceValue(def('SELECT', null), 'a')).toThrow(/not in allowed/);
    });
    it('returns null for nullish', () => {
      expect(coerceValue(def('SELECT', selectOpts), null)).toBeNull();
      expect(coerceValue(def('SELECT', selectOpts), '')).toBeNull();
    });
  });

  describe('MULTI_SELECT', () => {
    it('accepts an array of allowed values', () => {
      const cols = coerceValue(def('MULTI_SELECT', selectOpts), ['a', 'b']);
      expect(cols?.valueJson).toEqual(['a', 'b']);
    });
    it('dedupes', () => {
      const cols = coerceValue(def('MULTI_SELECT', selectOpts), ['a', 'a', 'b']);
      expect(cols?.valueJson).toEqual(['a', 'b']);
    });
    it('rejects unlisted values', () => {
      expect(() => coerceValue(def('MULTI_SELECT', selectOpts), ['a', 'c'])).toThrow(/not allowed/);
    });
    it('rejects non-array input', () => {
      expect(() => coerceValue(def('MULTI_SELECT', selectOpts), 'a' as unknown as string[])).toThrow(
        /array of strings/,
      );
    });
    it('treats empty array as clear', () => {
      expect(coerceValue(def('MULTI_SELECT', selectOpts), [])).toBeNull();
    });
  });
});

describe('valueFromRow', () => {
  // Synthetic row helper. Only the columns each branch reads matter.
  const row = (overrides: Record<string, unknown>) =>
    ({
      id: 0, definitionId: 0, entityType: 'CONTACT', entityId: 0,
      valueText: null, valueNumber: null, valueDate: null, valueBool: null, valueJson: null,
      createdAt: new Date(), updatedAt: new Date(), ...overrides,
    } as never);

  it('reads valueText for text-shaped types', () => {
    for (const t of ['TEXT', 'LONG_TEXT', 'EMAIL', 'URL', 'PHONE', 'SELECT'] as const) {
      expect(valueFromRow({ type: t }, row({ valueText: 'hi' }))).toBe('hi');
    }
  });

  it('converts Decimal to a JS number', () => {
    const r = row({ valueNumber: new Prisma.Decimal('1234.5678') });
    expect(valueFromRow({ type: 'MONEY' }, r)).toBe(1234.5678);
  });

  it('formats DATE as YYYY-MM-DD', () => {
    const r = row({ valueDate: new Date('2026-04-30T00:00:00.000Z') });
    expect(valueFromRow({ type: 'DATE' }, r)).toBe('2026-04-30');
  });

  it('returns valueBool for BOOLEAN, including false', () => {
    expect(valueFromRow({ type: 'BOOLEAN' }, row({ valueBool: false }))).toBe(false);
    expect(valueFromRow({ type: 'BOOLEAN' }, row({ valueBool: true }))).toBe(true);
  });

  it('returns the string array for MULTI_SELECT', () => {
    expect(valueFromRow({ type: 'MULTI_SELECT' }, row({ valueJson: ['a', 'b'] }))).toEqual(['a', 'b']);
  });

  it('returns null when MULTI_SELECT json is not an array', () => {
    expect(valueFromRow({ type: 'MULTI_SELECT' }, row({ valueJson: { not: 'array' } }))).toBeNull();
  });
});
