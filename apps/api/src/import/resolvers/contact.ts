import type { Prisma, PrismaClient } from '@prisma/client';

// Resolves a Deal's `primaryContactId` by looking up an existing Contact
// by email (case-insensitive). When no match is found we auto-create a
// stub Contact with only the email populated and the local-part split
// into firstName / lastName as a best-guess fallback — keeps Contact's
// NOT NULL firstName/lastName satisfied without inventing data.
//
// Cache is per-resolver-instance so a 100-deal import that all reference
// the same email does one DB hit.
export class ContactResolver {
  private byEmail = new Map<string, number>();
  public stubsCreated = 0;

  constructor(private prisma: PrismaClient | Prisma.TransactionClient) {}

  async resolveByEmail(emailRaw: string | null): Promise<number | null> {
    if (!emailRaw) return null;
    const email = emailRaw.trim().toLowerCase();
    if (email === '') return null;
    const cached = this.byEmail.get(email);
    if (cached !== undefined) return cached;
    const existing = await this.prisma.contact.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
      select: { id: true },
    });
    if (existing) {
      this.byEmail.set(email, existing.id);
      return existing.id;
    }
    // Local-part-as-name fallback. "jane.smith@acme.com" → first="Jane",
    // last="Smith" — better than two literal "(unknown)" strings, and
    // still trivially fixable by the user post-import.
    const local = email.split('@')[0] ?? '';
    const tokens = local.split(/[._+-]+/).filter(Boolean);
    const cap = (s: string) => (s.length > 0 ? (s[0] ?? '').toUpperCase() + s.slice(1) : '');
    const firstName = cap(tokens[0] ?? '') || 'Unknown';
    const lastName = cap(tokens.slice(1).join(' ')) || '(import)';
    const created = await this.prisma.contact.create({
      data: { firstName, lastName, email },
      select: { id: true },
    });
    this.byEmail.set(email, created.id);
    this.stubsCreated += 1;
    return created.id;
  }
}
