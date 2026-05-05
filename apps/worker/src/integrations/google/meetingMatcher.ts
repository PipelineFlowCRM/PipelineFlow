// Auto-link matcher — given a freshly-ingested Calendar event's attendee
// emails and the event title, decide which (Contact, Deal, Company) the
// resulting Meeting should anchor to. Pure data → decision; the worker
// hands in already-loaded Contact/Deal/Company candidates so this module
// stays Prisma-free and trivial to unit-test.
//
// The confidence ladder mirrors spec-auto-link-meeting.md:
//
//   1.00  single Contact match + single open Deal
//   0.85  single Contact match + Deal disambiguated by title
//   0.70  single Contact match + multiple open Deals (Contact only)
//   0.50  domain match only (no Contact, Company linked)
//   <0.50 do not auto-suggest
//
// The matcher's contract:
//   - Returns one decision plus a candidates trail for audit logging.
//   - Never invents a primary deal when ambiguity remains — the rep
//     confirms ambiguous cases.
//   - Knows nothing about persistence; that's the caller's job. This
//     means the same matcher can be reused unchanged when a future Push
//     ingest path needs to re-evaluate a Meeting after attendee edits.

export interface ContactCandidate {
  id: number;
  email: string | null;
  companyId: number | null;
}

export interface DealCandidate {
  id: number;
  title: string;
  // closed_won / closed_lost are EXCLUDED upstream — the matcher only
  // ever sees deals worth attaching to.
  primaryContactId: number | null;
  companyId: number | null;
}

export interface CompanyCandidate {
  id: number;
  domains: string[]; // normalized lowercase
}

export interface MatcherInputs {
  // Lowercased, trimmed attendee emails. Internal-domain attendees are
  // expected to be filtered out by the caller (we don't know what counts
  // as internal at this layer — it's per-org config).
  externalAttendeeEmails: string[];
  eventTitle: string;
  // Loaded by the caller from Postgres: any Contacts whose email matches
  // an attendee. Multiple Contacts is unusual but possible (shared inbox,
  // duplicates from imports).
  contactsByAttendee: ContactCandidate[];
  // Open deals associated with the matched contacts (or with their
  // companies). Caller filters to non-closed.
  openDealsByContact: Map<number, DealCandidate[]>;
  // For domain-match fallback: companies whose `domains[]` contains any
  // attendee email's domain.
  companiesByDomain: CompanyCandidate[];
}

export interface AuditCandidate {
  kind: 'contact' | 'deal' | 'company';
  id: number;
  score: number;
  reason: string;
}

export interface MatchDecision {
  primaryContactId: number | null;
  primaryDealId: number | null;
  primaryCompanyId: number | null;
  // 0.00 — 1.00. We persist as Decimal(3,2); store the rounded value.
  confidence: number;
  // 'email_match' | 'domain_match' | 'title_match' | null when nothing
  // could be linked.
  method: 'email_match' | 'domain_match' | 'title_match' | null;
  // Final state — caller maps to Meeting.linkStatus.
  // 'confirmed' is reserved for the confidence === 1.00 path *iff* the
  // org has auto-confirm enabled. The matcher emits 'auto_confirmed' so
  // the caller can decide whether to honor it; downgrades to 'suggested'
  // when org policy disallows.
  outcome: 'auto_confirmed' | 'suggested' | 'unlinked';
  candidates: AuditCandidate[];
}

const SCORE_FULL = 1.0;
const SCORE_TITLE_DISAMBIGUATED = 0.85;
const SCORE_CONTACT_ONLY = 0.7;
const SCORE_DOMAIN_ONLY = 0.5;

export function decideMatch(input: MatcherInputs): MatchDecision {
  const trail: AuditCandidate[] = [];

  // Email match — collect unique contacts hit by the attendee list. If
  // multiple Contacts hit (same email on two records — rare but happens),
  // fall through to "no clean contact match" and let the matcher try
  // domain match instead.
  const uniqueContacts = uniqueById(input.contactsByAttendee);
  for (const c of uniqueContacts) {
    trail.push({
      kind: 'contact',
      id: c.id,
      score: SCORE_CONTACT_ONLY,
      reason: 'attendee email matched contact',
    });
  }

  if (uniqueContacts.length === 1) {
    const contact = uniqueContacts[0]!;
    const deals = input.openDealsByContact.get(contact.id) ?? [];
    if (deals.length === 1) {
      const deal = deals[0]!;
      trail.push({
        kind: 'deal',
        id: deal.id,
        score: SCORE_FULL,
        reason: 'sole open deal on the matched contact',
      });
      return {
        primaryContactId: contact.id,
        primaryDealId: deal.id,
        primaryCompanyId: contact.companyId,
        confidence: SCORE_FULL,
        method: 'email_match',
        outcome: 'auto_confirmed',
        candidates: trail,
      };
    }
    if (deals.length > 1) {
      // Title disambiguation. We score each deal by how many of its
      // *distinctive* tokens appear in the event title, then pick the
      // deal that strictly out-scores its peers. "Distinctive" excludes
      // tokens that are shared by every candidate deal — those are
      // typically the company / account name (e.g. "Acme" in both
      // "Acme Q3 Renewal" and "Acme Expansion"), which carry no
      // signal for picking *between* the two.
      const title = input.eventTitle.toLowerCase();
      const tokenSets = deals.map((d) => tokensOf(d.title));
      const sharedByAll = new Set<string>();
      if (tokenSets[0]) {
        for (const t of tokenSets[0]) {
          if (tokenSets.every((set) => set.has(t))) sharedByAll.add(t);
        }
      }
      const scores = deals.map((d, i) => {
        const distinctive = Array.from(tokenSets[i]!).filter(
          (t) => !sharedByAll.has(t) && t.length > 3,
        );
        const hits = distinctive.filter((t) => title.includes(t)).length;
        return { deal: d, score: hits };
      });
      for (const { deal, score } of scores) {
        trail.push({
          kind: 'deal',
          id: deal.id,
          score: score > 0 ? SCORE_TITLE_DISAMBIGUATED : 0,
          reason:
            score > 0
              ? `${score} distinctive token(s) from the deal title appear in the event title`
              : 'open deal on contact, but no distinctive token match',
        });
      }
      const ranked = [...scores].sort((a, b) => b.score - a.score);
      const best = ranked[0];
      const runnerUp = ranked[1];
      if (best && runnerUp && best.score > 0 && best.score > runnerUp.score) {
        return {
          primaryContactId: contact.id,
          primaryDealId: best.deal.id,
          primaryCompanyId: contact.companyId,
          confidence: SCORE_TITLE_DISAMBIGUATED,
          method: 'title_match',
          outcome: 'suggested',
          candidates: trail,
        };
      }
      // Multiple deals, no clean disambiguation — link the contact, leave
      // deal pending. UI prompts the rep to pick one.
      return {
        primaryContactId: contact.id,
        primaryDealId: null,
        primaryCompanyId: contact.companyId,
        confidence: SCORE_CONTACT_ONLY,
        method: 'email_match',
        outcome: 'suggested',
        candidates: trail,
      };
    }
    // Contact matched, no open deals — still attach the contact and
    // company so the meeting shows up in the right contact's history.
    return {
      primaryContactId: contact.id,
      primaryDealId: null,
      primaryCompanyId: contact.companyId,
      confidence: SCORE_CONTACT_ONLY,
      method: 'email_match',
      outcome: 'suggested',
      candidates: trail,
    };
  }

  // No clean contact match (zero contacts or multiple). Fall back to
  // domain match: if all external attendees share a single Company
  // domain, link the company. Multi-company attendee lists (a meeting
  // with two customers!) intentionally don't auto-link to either — the
  // rep handles those manually.
  if (input.companiesByDomain.length === 1) {
    const company = input.companiesByDomain[0]!;
    trail.push({
      kind: 'company',
      id: company.id,
      score: SCORE_DOMAIN_ONLY,
      reason: 'attendee email domain matched company',
    });
    return {
      primaryContactId: null,
      primaryDealId: null,
      primaryCompanyId: company.id,
      confidence: SCORE_DOMAIN_ONLY,
      method: 'domain_match',
      outcome: 'suggested',
      candidates: trail,
    };
  }

  // Nothing matched. Surface the empty trail anyway — the audit row tells
  // the operator the matcher *did* run and there were no candidates to
  // pick from.
  return {
    primaryContactId: null,
    primaryDealId: null,
    primaryCompanyId: null,
    confidence: 0,
    method: null,
    outcome: 'unlinked',
    candidates: trail,
  };
}

function tokensOf(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );
}

function uniqueById<T extends { id: number }>(arr: T[]): T[] {
  const seen = new Set<number>();
  const out: T[] = [];
  for (const item of arr) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

// Pull the lowercased domain out of an email — used by callers to build
// the companiesByDomain set. Robust to surrounding whitespace and the
// `Display Name <email>` wrapping that Calendar can hand back.
export function domainOf(email: string): string | null {
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.lastIndexOf('@');
  if (at < 0 || at === trimmed.length - 1) return null;
  // Strip a possible angle-bracket wrapper.
  let dom = trimmed.slice(at + 1);
  if (dom.endsWith('>')) dom = dom.slice(0, -1);
  return dom || null;
}
