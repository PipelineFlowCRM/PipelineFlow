import { describe, expect, it } from 'vitest';
import { ZodError, z } from 'zod';
import { Prisma } from '@prisma/client';
import { HttpError } from '../lib/error.js';
import { sanitizeErrorMessage, stripConfirmationToken } from './server.js';

describe('stripConfirmationToken', () => {
  it('removes confirmationToken from a plain object', () => {
    expect(
      stripConfirmationToken({ id: 1, confirmationToken: 'appr_xyz' }),
    ).toEqual({ id: 1 });
  });

  it('passes through objects without the field', () => {
    expect(stripConfirmationToken({ id: 1 })).toEqual({ id: 1 });
  });

  it('passes through non-objects unchanged', () => {
    expect(stripConfirmationToken(null)).toBeNull();
    expect(stripConfirmationToken('hi')).toBe('hi');
    expect(stripConfirmationToken([1, 2, 3])).toEqual([1, 2, 3]);
  });

  it('does not recurse — only strips at the top level', () => {
    // We only ever take confirmationToken as a top-level arg; nested
    // structures stay untouched (and this keeps the helper trivial).
    const nested = { meta: { confirmationToken: 'should_stay' } };
    expect(stripConfirmationToken(nested)).toEqual(nested);
  });
});

describe('sanitizeErrorMessage', () => {
  it('passes through HttpError messages verbatim — those are user-facing already', () => {
    expect(sanitizeErrorMessage(new HttpError(404, 'Deal not found'))).toBe(
      'Deal not found',
    );
  });

  it('summarises Zod errors into field:message pairs', () => {
    const schema = z.object({ id: z.number().positive() });
    let err: unknown;
    try {
      schema.parse({ id: -1 });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ZodError);
    const out = sanitizeErrorMessage(err);
    expect(out).toMatch(/Validation failed/);
    expect(out).toMatch(/id:/);
  });

  it('maps known Prisma codes to safe labels', () => {
    const p2002 = new Prisma.PrismaClientKnownRequestError(
      'duplicate key on Tag(name)',
      { code: 'P2002', clientVersion: '5.x', meta: { target: ['name'] } },
    );
    expect(sanitizeErrorMessage(p2002)).toBe('Resource already exists');

    const p2025 = new Prisma.PrismaClientKnownRequestError(
      'record not found',
      { code: 'P2025', clientVersion: '5.x' },
    );
    expect(sanitizeErrorMessage(p2025)).toBe('Not found');

    const p2003 = new Prisma.PrismaClientKnownRequestError(
      'fk violation',
      { code: 'P2003', clientVersion: '5.x' },
    );
    expect(sanitizeErrorMessage(p2003)).toBe('Cannot complete: related records exist');
  });

  it('does not leak Prisma metadata for unknown codes', () => {
    const unknown = new Prisma.PrismaClientKnownRequestError(
      'internal column "secret_hash" violation',
      { code: 'P9999', clientVersion: '5.x' },
    );
    const out = sanitizeErrorMessage(unknown);
    expect(out).not.toMatch(/secret_hash/);
    expect(out).toMatch(/Database error/);
  });

  it('falls back to a generic message for non-Error values', () => {
    expect(sanitizeErrorMessage('something weird')).toBeTruthy();
    expect(sanitizeErrorMessage(null)).toBeTruthy();
  });
});
