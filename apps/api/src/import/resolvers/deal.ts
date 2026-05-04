import type { Prisma, PrismaClient } from '@prisma/client';

// Resolves a Note's parent `dealId` from the source CSV. Externalized
// here so the importer can share a per-job cache: a Pipedrive Notes
// export with 21 deal-attached notes and 5 distinct deals does 5 DB
// hits, not 21.
//
// Resolution order:
//   1. (externalSource, externalId) — exact match on the Deal's
//      Pipedrive identity. Requires the user imported Deals with the
//      `Deal - ID` column mapped to externalId.
//   2. case-insensitive title match — soft fallback. Surfaces ambiguous
//      titles back to the caller as `ambiguous` so the runner can
//      convert them into row-level errors.
//
// Unlike the Company / Contact resolvers, we *never* auto-create stub
// Deals. A note pointing at a missing Deal is a cross-import error,
// not a thing to silently paper over — the user needs to import the
// Deal first.
export type DealResolveResult =
  | { kind: 'found'; dealId: number }
  | { kind: 'missing' }
  | { kind: 'ambiguous'; matchCount: number };

export class DealResolver {
  // Cache by both keys so subsequent rows with the same identifiers
  // reuse the lookup. Cache values include the result kind so a known-
  // ambiguous title doesn't get re-resolved per row.
  private byExternal = new Map<string, DealResolveResult>();
  private byTitle = new Map<string, DealResolveResult>();

  constructor(
    private prisma: PrismaClient | Prisma.TransactionClient,
    private externalSource: string,
  ) {}

  async resolve(input: {
    externalId: string | null;
    title: string | null;
  }): Promise<DealResolveResult> {
    if (input.externalId) {
      const cacheKey = `ext:${this.externalSource}:${input.externalId}`;
      const cached = this.byExternal.get(cacheKey);
      if (cached) return cached;
      const found = await this.prisma.deal.findUnique({
        where: {
          deal_external_uq: {
            externalSource: this.externalSource,
            externalId: input.externalId,
          },
        },
        select: { id: true },
      });
      if (found) {
        const result: DealResolveResult = { kind: 'found', dealId: found.id };
        this.byExternal.set(cacheKey, result);
        return result;
      }
      // Fall through to title — Pipedrive sometimes drops the Deal ID
      // column from a CSV the user has already exported and changed.
    }
    if (input.title) {
      const key = input.title.trim().toLowerCase();
      if (key === '') return { kind: 'missing' };
      const cached = this.byTitle.get(key);
      if (cached) return cached;
      // Title fallback resolves in two passes:
      //   1. Prefer Deals with no external identity stamped — those are
      //      the natural targets for a "we re-exported with the ID
      //      column" bridge or a genuinely-not-yet-imported parent.
      //   2. If no unstamped match exists, look at *any* title-matched
      //      Deal. A note attaching to a Deal that's already stamped
      //      with a *different* externalId is suspicious enough to
      //      surface as ambiguous rather than silently bind.
      // Cap each pass at 2 — we only need to detect "exactly one" vs.
      // "more than one"; the actual count beyond 2 doesn't matter.
      const unstamped = await this.prisma.deal.findMany({
        where: {
          title: { equals: input.title, mode: 'insensitive' },
          externalId: null,
        },
        select: { id: true },
        take: 2,
      });
      let result: DealResolveResult;
      if (unstamped.length === 1) {
        result = { kind: 'found', dealId: unstamped[0]!.id };
      } else if (unstamped.length >= 2) {
        result = { kind: 'ambiguous', matchCount: unstamped.length };
      } else {
        // Zero unstamped matches — check if any stamped Deals share the
        // title. If so, refuse to bind (would attach to the wrong
        // Pipedrive identity). Otherwise the parent Deal genuinely
        // doesn't exist.
        const stamped = await this.prisma.deal.findMany({
          where: {
            title: { equals: input.title, mode: 'insensitive' },
            NOT: { externalId: null },
          },
          select: { id: true },
          take: 1,
        });
        result =
          stamped.length > 0
            ? { kind: 'ambiguous', matchCount: stamped.length }
            : { kind: 'missing' };
      }
      this.byTitle.set(key, result);
      return result;
    }
    return { kind: 'missing' };
  }
}
