import { describe, expect, it } from 'vitest';
import {
  decideMatch,
  domainOf,
  type DealCandidate,
  type MatcherInputs,
} from './meetingMatcher.js';

// Pure-function tests — the matcher is deliberately Prisma-free so the
// fixtures here line up 1:1 with what the worker passes in.

function baseInput(over: Partial<MatcherInputs> = {}): MatcherInputs {
  return {
    externalAttendeeEmails: [],
    eventTitle: '',
    contactsByAttendee: [],
    openDealsByContact: new Map(),
    companiesByDomain: [],
    ...over,
  };
}

describe('decideMatch', () => {
  it('auto-confirms a single-contact / single-deal match at 1.00', () => {
    const deal: DealCandidate = {
      id: 100,
      title: 'Acme Q3 Renewal',
      primaryContactId: 1,
      companyId: 7,
    };
    const decision = decideMatch(
      baseInput({
        externalAttendeeEmails: ['jane@acme.com'],
        eventTitle: 'Acme renewal call',
        contactsByAttendee: [{ id: 1, email: 'jane@acme.com', companyId: 7 }],
        openDealsByContact: new Map([[1, [deal]]]),
      }),
    );
    expect(decision.outcome).toBe('auto_confirmed');
    expect(decision.confidence).toBe(1);
    expect(decision.primaryDealId).toBe(100);
    expect(decision.method).toBe('email_match');
  });

  it('drops to title disambiguation at 0.85 when multiple deals match', () => {
    const renewal: DealCandidate = {
      id: 100,
      title: 'Acme Q3 Renewal',
      primaryContactId: 1,
      companyId: 7,
    };
    const expansion: DealCandidate = {
      id: 200,
      title: 'Acme Expansion',
      primaryContactId: 1,
      companyId: 7,
    };
    const decision = decideMatch(
      baseInput({
        externalAttendeeEmails: ['jane@acme.com'],
        eventTitle: 'Acme renewal call',
        contactsByAttendee: [{ id: 1, email: 'jane@acme.com', companyId: 7 }],
        openDealsByContact: new Map([[1, [renewal, expansion]]]),
      }),
    );
    expect(decision.outcome).toBe('suggested');
    expect(decision.confidence).toBeCloseTo(0.85, 2);
    expect(decision.primaryDealId).toBe(100);
    expect(decision.method).toBe('title_match');
  });

  it('leaves the deal pending when title is too generic to disambiguate', () => {
    const renewal: DealCandidate = {
      id: 100,
      title: 'Acme Q3 Renewal',
      primaryContactId: 1,
      companyId: 7,
    };
    const expansion: DealCandidate = {
      id: 200,
      title: 'Acme Expansion',
      primaryContactId: 1,
      companyId: 7,
    };
    const decision = decideMatch(
      baseInput({
        externalAttendeeEmails: ['jane@acme.com'],
        eventTitle: 'Acme call',
        contactsByAttendee: [{ id: 1, email: 'jane@acme.com', companyId: 7 }],
        openDealsByContact: new Map([[1, [renewal, expansion]]]),
      }),
    );
    expect(decision.outcome).toBe('suggested');
    expect(decision.confidence).toBeCloseTo(0.7, 2);
    expect(decision.primaryDealId).toBeNull();
    expect(decision.primaryContactId).toBe(1);
  });

  it('falls back to domain match when no contact matches', () => {
    const decision = decideMatch(
      baseInput({
        externalAttendeeEmails: ['someone@acme.com'],
        eventTitle: 'Acme intro',
        companiesByDomain: [{ id: 7, domains: ['acme.com'] }],
      }),
    );
    expect(decision.outcome).toBe('suggested');
    expect(decision.confidence).toBeCloseTo(0.5, 2);
    expect(decision.method).toBe('domain_match');
    expect(decision.primaryCompanyId).toBe(7);
  });

  it('emits unlinked when nothing matches', () => {
    const decision = decideMatch(
      baseInput({ externalAttendeeEmails: ['stranger@example.org'] }),
    );
    expect(decision.outcome).toBe('unlinked');
    expect(decision.method).toBeNull();
  });

  it('does not auto-confirm when contact matched but no open deals', () => {
    const decision = decideMatch(
      baseInput({
        externalAttendeeEmails: ['jane@acme.com'],
        eventTitle: 'Catch-up',
        contactsByAttendee: [{ id: 1, email: 'jane@acme.com', companyId: 7 }],
        openDealsByContact: new Map(),
      }),
    );
    expect(decision.outcome).toBe('suggested');
    expect(decision.confidence).toBeCloseTo(0.7, 2);
    expect(decision.primaryDealId).toBeNull();
    expect(decision.primaryContactId).toBe(1);
  });

  it('refuses to disambiguate to multiple companies', () => {
    const decision = decideMatch(
      baseInput({
        externalAttendeeEmails: ['a@acme.com', 'b@example.com'],
        eventTitle: 'Joint review',
        companiesByDomain: [
          { id: 7, domains: ['acme.com'] },
          { id: 8, domains: ['example.com'] },
        ],
      }),
    );
    // Multi-company auto-link is intentionally out of scope.
    expect(decision.outcome).toBe('unlinked');
  });
});

describe('domainOf', () => {
  it('lowercases and trims', () => {
    expect(domainOf('  Jane@Acme.COM ')).toBe('acme.com');
  });
  it('handles `Display Name <email@x.com>` wrapping', () => {
    expect(domainOf('Jane Doe <jane@acme.com>')).toBe('acme.com');
  });
  it('returns null for malformed addresses', () => {
    expect(domainOf('jane@')).toBeNull();
    expect(domainOf('jane')).toBeNull();
  });
});
