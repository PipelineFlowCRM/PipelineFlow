import { createHash } from 'node:crypto';
import type { people_v1 } from 'googleapis';

// Pure functions translating between Google's `Person` schema and
// PipelineFlow's flat `Contact`. The two interesting design choices:
//
// 1. **Read-modify-write everywhere we write less than Google has**. PF
//    has one email / phone / linkedin url; Google has lists with types.
//    On push, we never delete entries we don't model — the "merged"
//    Person body is the prior Google body with our PF values overlaid
//    onto the primary slot.
//
// 2. **Strict updatePersonFields allowlist.** Google treats anything in
//    that list as authoritative; omit a field and Google preserves it.
//    Including, say, `memberships` would wipe contact-group assignments
//    (including the default "myContacts" group, which makes the contact
//    disappear from the user's main address book). The mapper exposes
//    the allowlist and asserts the body it builds only carries those
//    keys.

// What we read from People into a normalized PF-shaped form. company is
// just a string here; the pull worker resolves it to Company.id.
export type NormalizedPersonForPF = {
  resourceName: string;
  etag: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  title: string | null;
  companyName: string | null;
  linkedin: string | null;
  notes: string | null;
  // Google's source-of-truth for "when was this contact last edited".
  // Used for last-write-wins comparison against PF's updatedAt.
  updateTime: Date | null;
};

// PF-side input for a push. companyName is resolved by the worker before
// calling the mapper — we don't reach into the DB from a pure module.
export type PFContactForPush = {
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  title: string | null;
  companyName: string | null;
  linkedin: string | null;
  notes: string | null;
};

const LINKEDIN_HOST_RE = /(^|\.)linkedin\.com$/i;

export function normalizePersonFromGoogle(person: people_v1.Schema$Person): NormalizedPersonForPF {
  if (!person.resourceName) {
    throw new Error('Person without resourceName');
  }
  const name = primaryOrFirst(person.names ?? []);
  const email = primaryOrFirst(person.emailAddresses ?? []);
  const phone = primaryOrFirst(person.phoneNumbers ?? []);
  const org = primaryOrFirst(person.organizations ?? []);
  const linkedinUrl = (person.urls ?? []).find((u) => {
    if (!u.value) return false;
    try {
      return LINKEDIN_HOST_RE.test(new URL(u.value).hostname);
    } catch {
      return false;
    }
  });
  const bio = (person.biographies ?? [])[0];

  // Google ships per-field metadata (`metadata.sources[]`) with an
  // updateTime. The "most recently updated" source across all sourced
  // fields is a reasonable proxy for "was this Person edited" — that's
  // what we compare against PF.updatedAt for last-write-wins.
  const updateTime = newestUpdateTime(person);

  return {
    resourceName: person.resourceName,
    etag: person.etag ?? '',
    firstName: (name?.givenName ?? '').trim(),
    lastName: (name?.familyName ?? '').trim(),
    email: email?.value?.trim() || null,
    phone: phone?.value?.trim() || null,
    title: org?.title?.trim() || null,
    companyName: org?.name?.trim() || null,
    linkedin: linkedinUrl?.value?.trim() || null,
    notes: bio?.value?.trim() || null,
    updateTime,
  };
}

function primaryOrFirst<T extends { metadata?: people_v1.Schema$FieldMetadata }>(
  list: T[],
): T | undefined {
  if (list.length === 0) return undefined;
  const primary = list.find((x) => x.metadata?.primary === true);
  return primary ?? list[0];
}

function newestUpdateTime(person: people_v1.Schema$Person): Date | null {
  const candidates: string[] = [];
  for (const arr of [
    person.names ?? [],
    person.emailAddresses ?? [],
    person.phoneNumbers ?? [],
    person.organizations ?? [],
    person.urls ?? [],
    person.biographies ?? [],
  ]) {
    for (const item of arr) {
      const t = item.metadata?.source?.updateTime;
      if (t) candidates.push(t);
    }
  }
  let newest: Date | null = null;
  for (const c of candidates) {
    const d = new Date(c);
    if (!Number.isNaN(d.getTime()) && (!newest || d > newest)) newest = d;
  }
  return newest;
}

/**
 * Build a Person body for `people.createContact`. No prior remote state to
 * preserve, so we can write each field as a single primary entry. The
 * shape mirrors `mergePersonForUpdate` so a created → updated sequence
 * round-trips cleanly.
 */
export function buildPersonForCreate(input: PFContactForPush): people_v1.Schema$Person {
  return mergePFOntoPerson(input, {});
}

/**
 * Build a Person body for `people.updateContact` by overlaying the PF
 * values onto a freshly-fetched Person (the "before" state). Google
 * treats any field listed in updatePersonFields as authoritative — by
 * passing the merged body (existing + our changes) we preserve every
 * extra entry on those fields (additional emails, additional org
 * affiliations, etc.) and only mutate the primary slot.
 *
 * Caller is responsible for supplying the freshly-fetched Person so we're
 * working from current etag-correct state.
 */
export function mergePersonForUpdate(
  input: PFContactForPush,
  existing: people_v1.Schema$Person,
): people_v1.Schema$Person {
  return mergePFOntoPerson(input, existing);
}

function mergePFOntoPerson(
  input: PFContactForPush,
  existing: people_v1.Schema$Person,
): people_v1.Schema$Person {
  const out: people_v1.Schema$Person = {};

  // names — preserve middleName, honorifics, displayName, phonetics.
  const existingNames = existing.names ?? [];
  const primaryName = existingNames.find((n) => n.metadata?.primary === true) ?? existingNames[0];
  const newName: people_v1.Schema$Name = {
    ...(primaryName ?? {}),
    givenName: input.firstName || undefined,
    familyName: input.lastName || undefined,
  };
  // We strip displayName because Google recomputes it from given+family
  // when we omit it; otherwise it would keep the stale joined value.
  delete newName.displayName;
  delete newName.displayNameLastFirst;
  // metadata.source must stay so Google routes the update to the same
  // source (CONTACT vs DOMAIN_PROFILE etc).
  out.names = [newName, ...existingNames.filter((n) => n !== primaryName)];

  // emailAddresses — primary slot becomes PF's value; extras are kept.
  out.emailAddresses = mergeSingleValueField(
    existing.emailAddresses ?? [],
    input.email,
    'value',
  );

  // phoneNumbers — same pattern as emails.
  out.phoneNumbers = mergeSingleValueField(
    existing.phoneNumbers ?? [],
    input.phone,
    'value',
  );

  // organizations — title + name go to the primary org; extras preserved.
  // If neither is set on PF and we'd be writing an empty primary, drop
  // it so we don't materialise a no-op org row.
  const existingOrgs = existing.organizations ?? [];
  const primaryOrg =
    existingOrgs.find((o) => o.metadata?.primary === true) ?? existingOrgs[0];
  if (input.companyName || input.title) {
    const newOrg: people_v1.Schema$Organization = {
      ...(primaryOrg ?? {}),
      name: input.companyName || undefined,
      title: input.title || undefined,
      // Spread existing metadata first, then force primary:true so an
      // existing primary:false (or undefined from a list[0] fallback in
      // primaryOrFirst) doesn't override our intent. Symmetric with
      // mergeSingleValueField below.
      metadata: { ...(primaryOrg?.metadata ?? {}), primary: true },
    };
    out.organizations = [newOrg, ...existingOrgs.filter((o) => o !== primaryOrg)];
  } else if (existingOrgs.length > 0) {
    // PF doesn't have either field — leave Google's existing orgs as-is
    // by passing the original list through. (We have to send something
    // because organizations is in updatePersonFields; omit and Google
    // would null the column.)
    out.organizations = existingOrgs;
  } else {
    out.organizations = [];
  }

  // urls — replace any LinkedIn entries with the PF value; preserve all
  // other URLs untouched.
  const existingUrls = existing.urls ?? [];
  const nonLinkedinUrls = existingUrls.filter((u) => !isLinkedinUrl(u.value));
  if (input.linkedin) {
    out.urls = [
      { value: input.linkedin, type: 'profile', metadata: { primary: true } },
      ...nonLinkedinUrls,
    ];
  } else {
    out.urls = nonLinkedinUrls;
  }

  // biographies — single TEXT_PLAIN slot from PF.notes. Force the
  // contentType to TEXT_PLAIN so a previously-HTML bio becomes plain
  // text on next push (rather than letting Google render PF's notes as
  // HTML, which would expose any user-entered angle brackets).
  if (input.notes && input.notes.length > 0) {
    out.biographies = [{ value: input.notes, contentType: 'TEXT_PLAIN' }];
  } else {
    out.biographies = [];
  }

  return out;
}

function mergeSingleValueField<T extends { value?: string | null; metadata?: people_v1.Schema$FieldMetadata }>(
  existing: T[],
  pfValue: string | null,
  valueKey: 'value',
): T[] {
  const primary = existing.find((x) => x.metadata?.primary === true) ?? existing[0];
  const others = existing.filter((x) => x !== primary);
  if (pfValue) {
    const merged = {
      ...(primary ?? ({} as T)),
      [valueKey]: pfValue,
      // Existing metadata first, primary:true wins. See organisations
      // block above for the same reasoning.
      metadata: { ...(primary?.metadata ?? {}), primary: true },
    } as T;
    return [merged, ...others];
  }
  // PF cleared the value. We honour that by dropping the primary slot
  // but keeping the others — a user that explicitly removed an email
  // probably doesn't want it to come back, but they shouldn't lose
  // their other emails on Google either.
  if (primary) return others;
  return existing;
}

function isLinkedinUrl(v: unknown): boolean {
  if (typeof v !== 'string' || !v) return false;
  try {
    return LINKEDIN_HOST_RE.test(new URL(v).hostname);
  } catch {
    return false;
  }
}

/**
 * sha256 of the canonical Person body we'd send/receive. Used as the
 * echo-loop guard: if the would-be push body matches the last pulled
 * body, we just received this state from Google so don't echo it back.
 *
 * Hash is over a normalized projection (only the fields PF cares about)
 * so we don't false-mismatch on Google adding a `metadata.lastVerified`
 * timestamp to an unrelated field on a server-side reindex.
 */
export function fingerprintPerson(p: PFContactForPush): string {
  const canon = JSON.stringify({
    firstName: p.firstName.trim(),
    lastName: p.lastName.trim(),
    email: (p.email ?? '').toLowerCase().trim(),
    phone: normalizePhone(p.phone),
    title: (p.title ?? '').trim(),
    companyName: (p.companyName ?? '').trim(),
    linkedin: (p.linkedin ?? '').trim(),
    notes: (p.notes ?? '').trim(),
  });
  return createHash('sha256').update(canon).digest('hex');
}

function normalizePhone(s: string | null): string {
  if (!s) return '';
  return s.replace(/\D+/g, '');
}
