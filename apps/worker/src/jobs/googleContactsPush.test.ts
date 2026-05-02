import type { Job } from 'bullmq';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  GoogleContactsPushJobData,
  GoogleContactsPushJobResult,
} from '@pipelineflow/shared';
import { fingerprintPerson } from '../integrations/google/contactMapper.js';

// Mock all the IO surfaces. Prisma's models we touch + the people-client
// factory + the env getter. The prismaMocks shape reflects exactly which
// queries the push job runs; each test scripts the responses it needs.

const prismaMocks = vi.hoisted(() => ({
  googleAccount: { findUnique: vi.fn() },
  googleContactsSync: { findUnique: vi.fn(), update: vi.fn() },
  contact: { findUnique: vi.fn() },
  contactGoogleLink: {
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
  },
}));

const peopleMocks = vi.hoisted(() => ({
  buildPeopleClient: vi.fn(),
  loadGoogleAccount: vi.fn(),
  disableAccount: vi.fn(),
  isInvalidGrant: vi.fn(),
  statusCodeOf: vi.fn(),
}));

vi.mock('../db.js', () => ({ prisma: prismaMocks }));
vi.mock('../integrations/google/peopleClient.js', async () => {
  const actual = await vi.importActual<object>(
    '../integrations/google/peopleClient.js',
  );
  return {
    ...actual,
    buildPeopleClient: peopleMocks.buildPeopleClient,
    loadGoogleAccount: peopleMocks.loadGoogleAccount,
    disableAccount: peopleMocks.disableAccount,
    isInvalidGrant: peopleMocks.isInvalidGrant,
    statusCodeOf: peopleMocks.statusCodeOf,
  };
});

const { processGoogleContactsPush } = await import('./googleContactsPush.js');

type FakeJob = Job<GoogleContactsPushJobData, GoogleContactsPushJobResult>;
const fakeJob = (data: GoogleContactsPushJobData): FakeJob =>
  ({ id: 'job-1', name: 'google-contacts-push', data } as unknown as FakeJob);

const baseAccount = {
  id: 1,
  userId: 1,
  disabledAt: null,
  encryptedRefreshToken: 'v1:x:y:z',
};
const baseSync = { googleAccountId: 1, outboundEnabled: true };
const baseContact = {
  id: 100,
  firstName: 'Jane',
  lastName: 'Doe',
  email: 'jane@example.com',
  phone: null,
  title: null,
  linkedin: null,
  notes: null,
  company: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  // Default: real status / invalid_grant detectors so the helpers behave.
  peopleMocks.isInvalidGrant.mockImplementation((err: unknown) => {
    return Boolean(
      err && typeof err === 'object' && (err as { invalid_grant?: boolean }).invalid_grant,
    );
  });
  peopleMocks.statusCodeOf.mockImplementation((err: unknown) => {
    if (err && typeof err === 'object') {
      const e = err as { code?: number };
      return e.code ?? null;
    }
    return null;
  });
});

describe('processGoogleContactsPush — gates', () => {
  it('skips when the account is disabled', async () => {
    peopleMocks.loadGoogleAccount.mockResolvedValueOnce({ ...baseAccount, disabledAt: new Date() });
    const result = await processGoogleContactsPush(
      fakeJob({ kind: 'upsert', contactId: 100, googleAccountId: 1 }),
    );
    expect(result.outcome).toBe('skipped-disabled');
  });

  it('skips when outbound is off', async () => {
    peopleMocks.loadGoogleAccount.mockResolvedValueOnce(baseAccount);
    prismaMocks.googleContactsSync.findUnique.mockResolvedValueOnce({
      ...baseSync,
      outboundEnabled: false,
    });
    const result = await processGoogleContactsPush(
      fakeJob({ kind: 'upsert', contactId: 100, googleAccountId: 1 }),
    );
    expect(result.outcome).toBe('skipped-disabled');
  });

  it('skips a missing contact', async () => {
    peopleMocks.loadGoogleAccount.mockResolvedValueOnce(baseAccount);
    prismaMocks.googleContactsSync.findUnique.mockResolvedValueOnce(baseSync);
    peopleMocks.buildPeopleClient.mockResolvedValueOnce({
      client: {} as never,
      oauth: {} as never,
      account: baseAccount,
    });
    prismaMocks.contact.findUnique.mockResolvedValueOnce(null);
    const result = await processGoogleContactsPush(
      fakeJob({ kind: 'upsert', contactId: 100, googleAccountId: 1 }),
    );
    expect(result.outcome).toBe('skipped-missing-link');
  });
});

describe('processGoogleContactsPush — echo guard', () => {
  it('skips when every link\'s lastPulledHash equals wouldHash', async () => {
    const wouldHash = fingerprintPerson({
      firstName: 'Jane',
      lastName: 'Doe',
      email: 'jane@example.com',
      phone: null,
      title: null,
      companyName: null,
      linkedin: null,
      notes: null,
    });
    peopleMocks.loadGoogleAccount.mockResolvedValueOnce(baseAccount);
    prismaMocks.googleContactsSync.findUnique.mockResolvedValueOnce(baseSync);
    peopleMocks.buildPeopleClient.mockResolvedValueOnce({
      client: { people: { get: vi.fn(), updateContact: vi.fn(), createContact: vi.fn() } } as never,
      oauth: {} as never,
      account: baseAccount,
    });
    prismaMocks.contact.findUnique.mockResolvedValueOnce(baseContact);
    prismaMocks.contactGoogleLink.findMany.mockResolvedValueOnce([
      { id: 1, resourceName: 'people/c1', etag: 'e1', lastPulledHash: wouldHash, lastPushedHash: null },
    ]);
    const result = await processGoogleContactsPush(
      fakeJob({ kind: 'upsert', contactId: 100, googleAccountId: 1 }),
    );
    expect(result.outcome).toBe('skipped-echo');
  });
});

describe('processGoogleContactsPush — create flow', () => {
  it('creates on Google when no link exists, then writes a link row', async () => {
    peopleMocks.loadGoogleAccount.mockResolvedValueOnce(baseAccount);
    prismaMocks.googleContactsSync.findUnique.mockResolvedValueOnce(baseSync);
    const createContact = vi.fn().mockResolvedValueOnce({
      data: { resourceName: 'people/cNEW', etag: 'eNEW' },
    });
    peopleMocks.buildPeopleClient.mockResolvedValueOnce({
      client: { people: { createContact, get: vi.fn(), updateContact: vi.fn() } } as never,
      oauth: {} as never,
      account: baseAccount,
    });
    prismaMocks.contact.findUnique.mockResolvedValueOnce(baseContact);
    prismaMocks.contactGoogleLink.findMany.mockResolvedValueOnce([]);
    prismaMocks.contactGoogleLink.create.mockResolvedValueOnce(undefined);
    prismaMocks.googleContactsSync.update.mockResolvedValueOnce(undefined);

    const result = await processGoogleContactsPush(
      fakeJob({ kind: 'upsert', contactId: 100, googleAccountId: 1 }),
    );
    expect(result.outcome).toBe('pushed');
    expect(createContact).toHaveBeenCalledOnce();
    expect(prismaMocks.contactGoogleLink.create).toHaveBeenCalledOnce();
    expect(prismaMocks.contactGoogleLink.create.mock.calls[0]?.[0]?.data).toMatchObject({
      contactId: 100,
      resourceName: 'people/cNEW',
      etag: 'eNEW',
    });
  });
});

describe('processGoogleContactsPush — update + 412 retry (H1)', () => {
  it('refetches a fresh etag on 412 and uses it on the retry', async () => {
    peopleMocks.loadGoogleAccount.mockResolvedValueOnce(baseAccount);
    prismaMocks.googleContactsSync.findUnique.mockResolvedValueOnce(baseSync);

    // First get() returns Person@etag-A. updateContact 412s.
    // Second get() returns Person@etag-B. updateContact succeeds.
    const get = vi
      .fn()
      .mockResolvedValueOnce({ data: { resourceName: 'people/c1', etag: 'etag-A', emailAddresses: [{ value: 'jane@example.com', metadata: { primary: true } }] } })
      .mockResolvedValueOnce({ data: { resourceName: 'people/c1', etag: 'etag-B', emailAddresses: [{ value: 'jane@example.com', metadata: { primary: true } }] } });
    const updateContact = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('412'), { code: 412 }))
      .mockResolvedValueOnce({ data: { resourceName: 'people/c1', etag: 'etag-B-NEW' } });

    peopleMocks.buildPeopleClient.mockResolvedValueOnce({
      client: { people: { get, updateContact, createContact: vi.fn() } } as never,
      oauth: {} as never,
      account: baseAccount,
    });
    prismaMocks.contact.findUnique.mockResolvedValueOnce(baseContact);
    prismaMocks.contactGoogleLink.findMany.mockResolvedValueOnce([
      { id: 1, resourceName: 'people/c1', etag: 'etag-STALE', lastPulledHash: null, lastPushedHash: null },
    ]);
    prismaMocks.contactGoogleLink.update.mockResolvedValueOnce(undefined);
    prismaMocks.googleContactsSync.update.mockResolvedValueOnce(undefined);

    const result = await processGoogleContactsPush(
      fakeJob({ kind: 'upsert', contactId: 100, googleAccountId: 1 }),
    );
    expect(result.outcome).toBe('pushed');
    expect(get).toHaveBeenCalledTimes(2);
    expect(updateContact).toHaveBeenCalledTimes(2);

    // Critical assertion: the second update used etag-B (fresh from
    // the second get), not etag-A (the first get's value) and not
    // etag-STALE (the link.etag from before the run).
    const secondUpdateBody = updateContact.mock.calls[1]?.[0]?.requestBody;
    expect(secondUpdateBody.etag).toBe('etag-B');
  });

  it('throws after two persistent 412s so BullMQ retries the whole job', async () => {
    peopleMocks.loadGoogleAccount.mockResolvedValueOnce(baseAccount);
    prismaMocks.googleContactsSync.findUnique.mockResolvedValueOnce(baseSync);

    const get = vi
      .fn()
      .mockResolvedValue({ data: { resourceName: 'people/c1', etag: 'etag-X' } });
    const updateContact = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('412'), { code: 412 }));

    peopleMocks.buildPeopleClient.mockResolvedValueOnce({
      client: { people: { get, updateContact, createContact: vi.fn() } } as never,
      oauth: {} as never,
      account: baseAccount,
    });
    prismaMocks.contact.findUnique.mockResolvedValueOnce(baseContact);
    prismaMocks.contactGoogleLink.findMany.mockResolvedValueOnce([
      { id: 1, resourceName: 'people/c1', etag: 'etag-STALE', lastPulledHash: null, lastPushedHash: null },
    ]);

    await expect(
      processGoogleContactsPush(fakeJob({ kind: 'upsert', contactId: 100, googleAccountId: 1 })),
    ).rejects.toThrow(/persistent etag conflict/);
  });
});

describe('processGoogleContactsPush — 404/410 recreate', () => {
  it('recreates the contact when get() returns 404', async () => {
    peopleMocks.loadGoogleAccount.mockResolvedValueOnce(baseAccount);
    prismaMocks.googleContactsSync.findUnique.mockResolvedValueOnce(baseSync);

    const get = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('404'), { code: 404 }));
    const createContact = vi.fn().mockResolvedValueOnce({
      data: { resourceName: 'people/cREBORN', etag: 'eREBORN' },
    });

    peopleMocks.buildPeopleClient.mockResolvedValueOnce({
      client: { people: { get, createContact, updateContact: vi.fn() } } as never,
      oauth: {} as never,
      account: baseAccount,
    });
    prismaMocks.contact.findUnique.mockResolvedValueOnce(baseContact);
    prismaMocks.contactGoogleLink.findMany.mockResolvedValueOnce([
      { id: 1, resourceName: 'people/cGONE', etag: 'e-old', lastPulledHash: null, lastPushedHash: null },
    ]);
    prismaMocks.contactGoogleLink.delete.mockResolvedValueOnce(undefined);
    prismaMocks.contactGoogleLink.create.mockResolvedValueOnce(undefined);
    prismaMocks.googleContactsSync.update.mockResolvedValueOnce(undefined);

    const result = await processGoogleContactsPush(
      fakeJob({ kind: 'upsert', contactId: 100, googleAccountId: 1 }),
    );
    expect(result.outcome).toBe('pushed');
    expect(prismaMocks.contactGoogleLink.delete).toHaveBeenCalledOnce();
    expect(createContact).toHaveBeenCalledOnce();
  });

  it('treats 410 the same as 404 on get()', async () => {
    peopleMocks.loadGoogleAccount.mockResolvedValueOnce(baseAccount);
    prismaMocks.googleContactsSync.findUnique.mockResolvedValueOnce(baseSync);
    const get = vi.fn().mockRejectedValueOnce(Object.assign(new Error('410'), { code: 410 }));
    const createContact = vi.fn().mockResolvedValueOnce({
      data: { resourceName: 'people/cREBORN', etag: 'eREBORN' },
    });
    peopleMocks.buildPeopleClient.mockResolvedValueOnce({
      client: { people: { get, createContact, updateContact: vi.fn() } } as never,
      oauth: {} as never,
      account: baseAccount,
    });
    prismaMocks.contact.findUnique.mockResolvedValueOnce(baseContact);
    prismaMocks.contactGoogleLink.findMany.mockResolvedValueOnce([
      { id: 1, resourceName: 'people/cGONE', etag: 'e-old', lastPulledHash: null, lastPushedHash: null },
    ]);
    prismaMocks.contactGoogleLink.delete.mockResolvedValueOnce(undefined);
    prismaMocks.contactGoogleLink.create.mockResolvedValueOnce(undefined);
    prismaMocks.googleContactsSync.update.mockResolvedValueOnce(undefined);

    const result = await processGoogleContactsPush(
      fakeJob({ kind: 'upsert', contactId: 100, googleAccountId: 1 }),
    );
    expect(result.outcome).toBe('pushed');
    expect(createContact).toHaveBeenCalledOnce();
  });
});

describe('processGoogleContactsPush — invalid_grant', () => {
  it('disables the account and skips when google rejects the refresh token', async () => {
    peopleMocks.loadGoogleAccount.mockResolvedValueOnce(baseAccount);
    prismaMocks.googleContactsSync.findUnique.mockResolvedValueOnce(baseSync);
    const get = vi.fn().mockRejectedValueOnce({ invalid_grant: true });
    peopleMocks.buildPeopleClient.mockResolvedValueOnce({
      client: { people: { get, updateContact: vi.fn(), createContact: vi.fn() } } as never,
      oauth: {} as never,
      account: baseAccount,
    });
    prismaMocks.contact.findUnique.mockResolvedValueOnce(baseContact);
    prismaMocks.contactGoogleLink.findMany.mockResolvedValueOnce([
      { id: 1, resourceName: 'people/c1', etag: 'e', lastPulledHash: null, lastPushedHash: null },
    ]);

    const result = await processGoogleContactsPush(
      fakeJob({ kind: 'upsert', contactId: 100, googleAccountId: 1 }),
    );
    expect(result.outcome).toBe('skipped-disabled');
    expect(peopleMocks.disableAccount).toHaveBeenCalledWith(1, 'invalid_grant');
  });
});

describe('processGoogleContactsPush — delete', () => {
  it('issues a People delete and removes the link row', async () => {
    peopleMocks.loadGoogleAccount.mockResolvedValueOnce(baseAccount);
    prismaMocks.googleContactsSync.findUnique.mockResolvedValueOnce(baseSync);
    const deleteContact = vi.fn().mockResolvedValueOnce(undefined);
    peopleMocks.buildPeopleClient.mockResolvedValueOnce({
      client: { people: { deleteContact, get: vi.fn(), createContact: vi.fn(), updateContact: vi.fn() } } as never,
      oauth: {} as never,
      account: baseAccount,
    });
    prismaMocks.contactGoogleLink.deleteMany.mockResolvedValueOnce(undefined);
    prismaMocks.googleContactsSync.update.mockResolvedValueOnce(undefined);

    const result = await processGoogleContactsPush(
      fakeJob({ kind: 'delete', resourceName: 'people/cBYE', googleAccountId: 1 }),
    );
    expect(result.outcome).toBe('pushed');
    expect(deleteContact).toHaveBeenCalledWith({ resourceName: 'people/cBYE' });
    expect(prismaMocks.contactGoogleLink.deleteMany).toHaveBeenCalledOnce();
  });

  it('treats 404 as already-gone and still cleans up the link row', async () => {
    peopleMocks.loadGoogleAccount.mockResolvedValueOnce(baseAccount);
    prismaMocks.googleContactsSync.findUnique.mockResolvedValueOnce(baseSync);
    const deleteContact = vi.fn().mockRejectedValueOnce(Object.assign(new Error('404'), { code: 404 }));
    peopleMocks.buildPeopleClient.mockResolvedValueOnce({
      client: { people: { deleteContact, get: vi.fn(), createContact: vi.fn(), updateContact: vi.fn() } } as never,
      oauth: {} as never,
      account: baseAccount,
    });
    prismaMocks.contactGoogleLink.deleteMany.mockResolvedValueOnce(undefined);
    prismaMocks.googleContactsSync.update.mockResolvedValueOnce(undefined);

    const result = await processGoogleContactsPush(
      fakeJob({ kind: 'delete', resourceName: 'people/cBYE', googleAccountId: 1 }),
    );
    expect(result.outcome).toBe('pushed');
    expect(prismaMocks.contactGoogleLink.deleteMany).toHaveBeenCalledOnce();
  });

  it('treats 410 as already-gone too', async () => {
    peopleMocks.loadGoogleAccount.mockResolvedValueOnce(baseAccount);
    prismaMocks.googleContactsSync.findUnique.mockResolvedValueOnce(baseSync);
    const deleteContact = vi.fn().mockRejectedValueOnce(Object.assign(new Error('410'), { code: 410 }));
    peopleMocks.buildPeopleClient.mockResolvedValueOnce({
      client: { people: { deleteContact, get: vi.fn(), createContact: vi.fn(), updateContact: vi.fn() } } as never,
      oauth: {} as never,
      account: baseAccount,
    });
    prismaMocks.contactGoogleLink.deleteMany.mockResolvedValueOnce(undefined);
    prismaMocks.googleContactsSync.update.mockResolvedValueOnce(undefined);

    const result = await processGoogleContactsPush(
      fakeJob({ kind: 'delete', resourceName: 'people/cBYE', googleAccountId: 1 }),
    );
    expect(result.outcome).toBe('pushed');
  });
});
