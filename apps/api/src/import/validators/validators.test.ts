import { describe, expect, it } from 'vitest';
import { validateCompanyRow } from './company.js';
import { validateContactRow } from './contact.js';
import { validateDealRow } from './deal.js';

describe('validateCompanyRow', () => {
  it('accepts a row with name and normalizes website', () => {
    const r = validateCompanyRow(
      { Name: 'Acme', Website: 'acme.com' },
      { Name: 'name', Website: 'website' },
      2,
    );
    expect(r.errors).toEqual([]);
    expect(r.data?.name).toBe('Acme');
    expect(r.data?.website).toBe('https://acme.com');
  });

  it('rejects a row without name', () => {
    const r = validateCompanyRow(
      { Website: 'acme.com' },
      { Website: 'website' },
      5,
    );
    expect(r.data).toBeNull();
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors[0]?.row).toBe(5);
  });
});

describe('validateContactRow', () => {
  it('accepts firstName + lastName + valid email', () => {
    const r = validateContactRow(
      { fn: 'Jane', ln: 'Doe', em: 'jane@example.com' },
      { fn: 'firstName', ln: 'lastName', em: 'email' },
      2,
    );
    expect(r.errors).toEqual([]);
    expect(r.data?.email).toBe('jane@example.com');
  });

  it('flags an invalid email but keeps the name', () => {
    const r = validateContactRow(
      { fn: 'Jane', ln: 'Doe', em: 'not-an-email' },
      { fn: 'firstName', ln: 'lastName', em: 'email' },
      2,
    );
    // We surface the error and clear the bad email; the row may still be valid.
    expect(r.errors.some((e) => /email/.test(e.reason))).toBe(true);
  });

  it('splits a full-name cell when only firstName is mapped', () => {
    const r = validateContactRow(
      { Name: 'Mary Watson' },
      { Name: 'firstName' },
      2,
    );
    expect(r.data?.firstName).toBe('Mary');
    expect(r.data?.lastName).toBe('Watson');
  });
});

describe('validateDealRow', () => {
  it('parses amount + date + stage', () => {
    const r = validateDealRow(
      {
        T: 'Big deal',
        A: '$1,234.56',
        D: '3/15/26',
        S: 'Qualified',
      },
      { T: 'title', A: 'amount', D: 'expectedCloseDate', S: 'stageName' },
      2,
    );
    expect(r.errors).toEqual([]);
    expect(r.data?.title).toBe('Big deal');
    expect(r.data?.amount).toBe(1234.56);
    expect(r.data?.expectedCloseDate).toBe('2026-03-15');
    expect(r.data?.stageName).toBe('Qualified');
  });

  it('errors when no stageName mapping', () => {
    const r = validateDealRow(
      { T: 'No stage' },
      { T: 'title' },
      3,
    );
    expect(r.data).toBeNull();
    expect(r.errors.some((e) => /stageName/.test(e.reason))).toBe(true);
  });
});
