import { describe, expect, it } from 'vitest';
import type { people_v1 } from 'googleapis';
import {
  buildPersonForCreate,
  fingerprintPerson,
  mergePersonForUpdate,
  normalizePersonFromGoogle,
  type PFContactForPush,
} from './contactMapper.js';

const samplePerson = (): people_v1.Schema$Person => ({
  resourceName: 'people/c123',
  etag: 'etag-1',
  names: [
    {
      givenName: 'Jane',
      familyName: 'Doe',
      middleName: 'Q',
      honorificPrefix: 'Dr.',
      metadata: { primary: true, source: { type: 'CONTACT', updateTime: '2025-01-01T00:00:00Z' } },
    },
  ],
  emailAddresses: [
    { value: 'jane@example.com', metadata: { primary: true } },
    { value: 'jane.alt@example.com' },
  ],
  phoneNumbers: [{ value: '+15551234567', metadata: { primary: true } }],
  organizations: [{ name: 'Acme', title: 'CTO', metadata: { primary: true } }],
  urls: [
    { value: 'https://www.linkedin.com/in/janedoe' },
    { value: 'https://example.com/jane' },
  ],
  biographies: [{ value: 'Likes hiking.', contentType: 'TEXT_PLAIN' }],
});

describe('normalizePersonFromGoogle', () => {
  it('extracts the primary slot of each list field', () => {
    const norm = normalizePersonFromGoogle(samplePerson());
    expect(norm.firstName).toBe('Jane');
    expect(norm.lastName).toBe('Doe');
    expect(norm.email).toBe('jane@example.com');
    expect(norm.phone).toBe('+15551234567');
    expect(norm.title).toBe('CTO');
    expect(norm.companyName).toBe('Acme');
    expect(norm.linkedin).toBe('https://www.linkedin.com/in/janedoe');
    expect(norm.notes).toBe('Likes hiking.');
    expect(norm.resourceName).toBe('people/c123');
    expect(norm.etag).toBe('etag-1');
  });

  it('falls back to first entry when no primary is marked', () => {
    const p = samplePerson();
    p.emailAddresses = [{ value: 'first@example.com' }, { value: 'second@example.com' }];
    const norm = normalizePersonFromGoogle(p);
    expect(norm.email).toBe('first@example.com');
  });

  it('returns nulls for missing fields', () => {
    const p: people_v1.Schema$Person = { resourceName: 'people/c456', etag: 'e' };
    const norm = normalizePersonFromGoogle(p);
    expect(norm.email).toBeNull();
    expect(norm.companyName).toBeNull();
    expect(norm.linkedin).toBeNull();
  });

  it('skips non-LinkedIn urls', () => {
    const p = samplePerson();
    p.urls = [{ value: 'https://example.com/jane' }];
    const norm = normalizePersonFromGoogle(p);
    expect(norm.linkedin).toBeNull();
  });
});

describe('mergePersonForUpdate', () => {
  it('preserves additional emails on push', () => {
    const existing = samplePerson();
    const pf: PFContactForPush = {
      firstName: 'Jane',
      lastName: 'Doe',
      email: 'jane@example.com',
      phone: '+15551234567',
      title: 'CTO',
      companyName: 'Acme',
      linkedin: 'https://www.linkedin.com/in/janedoe',
      notes: 'Likes hiking.',
    };
    const merged = mergePersonForUpdate(pf, existing);
    expect(merged.emailAddresses).toHaveLength(2);
    expect(merged.emailAddresses![0]!.value).toBe('jane@example.com');
    expect(merged.emailAddresses![0]!.metadata?.primary).toBe(true);
    expect(merged.emailAddresses![1]!.value).toBe('jane.alt@example.com');
  });

  it('preserves middleName + honorifics when overwriting given/family', () => {
    const existing = samplePerson();
    const pf: PFContactForPush = {
      firstName: 'Janet',
      lastName: 'Doe',
      email: null,
      phone: null,
      title: null,
      companyName: null,
      linkedin: null,
      notes: null,
    };
    const merged = mergePersonForUpdate(pf, existing);
    expect(merged.names![0]!.givenName).toBe('Janet');
    expect(merged.names![0]!.middleName).toBe('Q');
    expect(merged.names![0]!.honorificPrefix).toBe('Dr.');
    expect(merged.names![0]!.displayName).toBeUndefined();
  });

  it('preserves non-linkedin urls when updating linkedin', () => {
    const existing = samplePerson();
    const pf: PFContactForPush = {
      firstName: 'Jane',
      lastName: 'Doe',
      email: null,
      phone: null,
      title: null,
      companyName: null,
      linkedin: 'https://www.linkedin.com/in/jane2',
      notes: null,
    };
    const merged = mergePersonForUpdate(pf, existing);
    const linkedin = merged.urls!.filter((u) => u.value?.includes('linkedin'));
    const others = merged.urls!.filter((u) => !u.value?.includes('linkedin'));
    expect(linkedin).toHaveLength(1);
    expect(linkedin[0]!.value).toBe('https://www.linkedin.com/in/jane2');
    expect(others).toHaveLength(1);
    expect(others[0]!.value).toBe('https://example.com/jane');
  });

  it('forces TEXT_PLAIN biographies', () => {
    const existing = samplePerson();
    const pf: PFContactForPush = {
      firstName: 'Jane',
      lastName: 'Doe',
      email: null,
      phone: null,
      title: null,
      companyName: null,
      linkedin: null,
      notes: '<b>Hello</b>',
    };
    const merged = mergePersonForUpdate(pf, existing);
    expect(merged.biographies).toEqual([
      { value: '<b>Hello</b>', contentType: 'TEXT_PLAIN' },
    ]);
  });

  it('marks the merged email primary even when the existing slot was non-primary', () => {
    // Regression: an earlier version had the spread order backwards,
    // which let an existing primary:false override our primary:true.
    const existing: people_v1.Schema$Person = {
      resourceName: 'people/c1',
      etag: 'e',
      emailAddresses: [{ value: 'a@example.com', metadata: { primary: false } }],
    };
    const pf: PFContactForPush = {
      firstName: 'X',
      lastName: 'Y',
      email: 'b@example.com',
      phone: null,
      title: null,
      companyName: null,
      linkedin: null,
      notes: null,
    };
    const merged = mergePersonForUpdate(pf, existing);
    expect(merged.emailAddresses![0]!.value).toBe('b@example.com');
    expect(merged.emailAddresses![0]!.metadata?.primary).toBe(true);
  });

  it('marks the merged organization primary even when the existing org was non-primary', () => {
    const existing: people_v1.Schema$Person = {
      resourceName: 'people/c1',
      etag: 'e',
      organizations: [{ name: 'OldCo', metadata: { primary: false } }],
    };
    const pf: PFContactForPush = {
      firstName: 'X',
      lastName: 'Y',
      email: null,
      phone: null,
      title: 'CEO',
      companyName: 'NewCo',
      linkedin: null,
      notes: null,
    };
    const merged = mergePersonForUpdate(pf, existing);
    expect(merged.organizations![0]!.name).toBe('NewCo');
    expect(merged.organizations![0]!.metadata?.primary).toBe(true);
  });

  it('clears the primary email slot when PF email is null but keeps extras', () => {
    const existing = samplePerson();
    const pf: PFContactForPush = {
      firstName: 'Jane',
      lastName: 'Doe',
      email: null,
      phone: null,
      title: null,
      companyName: null,
      linkedin: null,
      notes: null,
    };
    const merged = mergePersonForUpdate(pf, existing);
    expect(merged.emailAddresses).toHaveLength(1);
    expect(merged.emailAddresses![0]!.value).toBe('jane.alt@example.com');
  });
});

describe('buildPersonForCreate', () => {
  it('emits the expected single-entry shape', () => {
    const pf: PFContactForPush = {
      firstName: 'Sam',
      lastName: 'Smith',
      email: 'sam@example.com',
      phone: '+15551112222',
      title: 'PM',
      companyName: 'Globex',
      linkedin: 'https://www.linkedin.com/in/sam',
      notes: 'Prefers async.',
    };
    const body = buildPersonForCreate(pf);
    expect(body.names![0]!.givenName).toBe('Sam');
    expect(body.emailAddresses![0]!.value).toBe('sam@example.com');
    expect(body.phoneNumbers![0]!.value).toBe('+15551112222');
    expect(body.organizations![0]!.name).toBe('Globex');
    expect(body.organizations![0]!.title).toBe('PM');
    expect(body.urls![0]!.value).toBe('https://www.linkedin.com/in/sam');
    expect(body.biographies![0]!.value).toBe('Prefers async.');
  });
});

describe('fingerprintPerson', () => {
  const base: PFContactForPush = {
    firstName: 'Jane',
    lastName: 'Doe',
    email: 'jane@example.com',
    phone: '(555) 123-4567',
    title: 'CTO',
    companyName: 'Acme',
    linkedin: 'https://www.linkedin.com/in/janedoe',
    notes: 'Likes hiking.',
  };

  it('is stable across whitespace and email casing', () => {
    const a = fingerprintPerson(base);
    const b = fingerprintPerson({
      ...base,
      email: 'JANE@EXAMPLE.COM',
      firstName: ' Jane ',
    });
    expect(a).toBe(b);
  });

  it('normalizes phone digits', () => {
    const a = fingerprintPerson(base);
    const b = fingerprintPerson({ ...base, phone: '5551234567' });
    expect(a).toBe(b);
  });

  it('changes when a relevant field changes', () => {
    const a = fingerprintPerson(base);
    const b = fingerprintPerson({ ...base, title: 'CEO' });
    expect(a).not.toBe(b);
  });
});
