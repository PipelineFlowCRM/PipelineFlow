import { describe, expect, it } from 'vitest';
import { normalizeHeader, suggestField, suggestMapping } from './mapping.js';

describe('normalizeHeader', () => {
  it('drops case and non-alphanum', () => {
    expect(normalizeHeader('First Name')).toBe('firstname');
    expect(normalizeHeader('first_name')).toBe('firstname');
    expect(normalizeHeader('FIRST-NAME')).toBe('firstname');
  });
});

describe('suggestField', () => {
  it('matches exact synonyms', () => {
    const r = suggestField('First Name', 'contact');
    expect(r.field).toBe('firstName');
    expect(r.confidence).toBe(1);
  });

  it('returns null when no synonym is close enough', () => {
    expect(suggestField('Random Custom Field', 'contact').field).toBeNull();
  });

  it('matches Pipedrive-style prefixed columns', () => {
    // "Person - Email" → email synonym is "email"; "person email" normalizes
    // to "personemail" — close prefix-suffix overlap to "email".
    const r = suggestField('Person - Email', 'contact');
    expect(r.field).toBe('email');
  });
});

describe('suggestMapping', () => {
  it('maps a generic First Name / Last Name / Email / Company contact CSV', () => {
    const headers = ['First Name', 'Last Name', 'Email', 'Company'];
    const m = suggestMapping(headers, 'contact');
    expect(m['First Name']).toBe('firstName');
    expect(m['Last Name']).toBe('lastName');
    expect(m['Email']).toBe('email');
    expect(m['Company']).toBe('companyName');
  });

  it('does not double-assign the same canonical field', () => {
    // Two columns with the same canonical alias — only the higher-scoring one wins.
    const headers = ['First Name', 'fname'];
    const m = suggestMapping(headers, 'contact');
    const assigned = Object.values(m).filter(Boolean);
    const dedup = new Set(assigned);
    expect(assigned.length).toBe(dedup.size);
  });
});
