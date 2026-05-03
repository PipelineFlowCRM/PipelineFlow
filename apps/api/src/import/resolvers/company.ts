import type { Prisma, PrismaClient } from '@prisma/client';

// Resolves a Contact's or Deal's `companyId` from the source CSV's
// company-name / company-external-id columns. Externalized into a class so
// the import job can share a per-job cache: a 1 000-row file with 30
// references to "Acme Corp" creates exactly one DB lookup, not 30.
//
// Resolution order:
//   1. (externalSource, externalId) — exact, idempotent.
//   2. lower(name) match — single-tenant CRM, name uniqueness is enforced.
//   3. Create a stub Company with just `name` set. Counted as a stub so
//      the user can review them post-import.
export class CompanyResolver {
  // Cache keyed on lower(name) | "ext:<source>:<id>". Values are the
  // resolved companyId, or null if neither lookup succeeded and we don't
  // have a name to stub from (latter shouldn't happen given the input
  // shape, but the cache slot keeps us from rechecking the same null).
  private byName = new Map<string, number>();
  private byExternal = new Map<string, number>();
  // Companies we created during this import run. Surfaced in the summary
  // so the user can find and merge them if needed.
  public stubsCreated = 0;

  constructor(
    private prisma: PrismaClient | Prisma.TransactionClient,
    private externalSource: string,
  ) {}

  async resolve(input: {
    name: string | null;
    externalId: string | null;
  }): Promise<number | null> {
    if (input.externalId) {
      const cacheKey = `ext:${this.externalSource}:${input.externalId}`;
      const cached = this.byExternal.get(cacheKey);
      if (cached !== undefined) return cached;
      const found = await this.prisma.company.findUnique({
        where: {
          company_external_uq: {
            externalSource: this.externalSource,
            externalId: input.externalId,
          },
        },
        select: { id: true },
      });
      if (found) {
        this.byExternal.set(cacheKey, found.id);
        return found.id;
      }
      // Fall through to name match — the externalId might point to a
      // Pipedrive Org that we never imported but whose name we already
      // know via a previously-imported Contact's `Person - Organization`.
    }
    if (!input.name) return null;
    const key = input.name.trim().toLowerCase();
    if (key === '') return null;
    const cached = this.byName.get(key);
    if (cached !== undefined) return cached;
    // findFirst with case-insensitive equals — schema has @@index([name])
    // and a separate functional unique index on lower(name) (raw SQL
    // migration in 20260430000000_init).
    const existing = await this.prisma.company.findFirst({
      where: { name: { equals: input.name, mode: 'insensitive' } },
      select: { id: true },
    });
    if (existing) {
      this.byName.set(key, existing.id);
      return existing.id;
    }
    // Stub creation. We attach the externalId only if we have one and it
    // didn't resolve above — otherwise re-importing the org export later
    // would create a duplicate.
    const created = await this.prisma.company.create({
      data: {
        name: input.name.trim(),
        ...(input.externalId
          ? { externalId: input.externalId, externalSource: this.externalSource }
          : {}),
      },
      select: { id: true },
    });
    this.byName.set(key, created.id);
    if (input.externalId) {
      this.byExternal.set(`ext:${this.externalSource}:${input.externalId}`, created.id);
    }
    this.stubsCreated += 1;
    return created.id;
  }
}
