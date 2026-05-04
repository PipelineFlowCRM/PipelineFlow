import { describe, expect, it } from 'vitest';
import { applyPreset, detectPreset, PRESETS } from './index.js';

describe('detectPreset', () => {
  it('detects a Pipedrive Persons export with full headers', () => {
    const headers = [
      'Person - Name',
      'Person - First name',
      'Person - Last name',
      'Person - Email',
      'Person - Phone',
      'Person - Job title',
      'Person - Organization',
      'Person - Owner',
      'Person - ID',
    ];
    const m = detectPreset(headers);
    expect(m).not.toBeNull();
    expect(m?.preset.key).toBe('pipedrive-persons');
    expect(m?.score).toBeGreaterThanOrEqual(0.7);
  });

  it('does not match a hand-built CSV with different names', () => {
    const headers = ['First', 'Last', 'Mail', 'Co.'];
    expect(detectPreset(headers)).toBeNull();
  });

  it('detects a real Pipedrive Organizations export with modern long-form column names', () => {
    // Captured verbatim from a 2026 Pipedrive export — the modern format
    // suffixes address subfields with "of Company Address" because the
    // address itself is now a custom field. The original spec appendix
    // listed shorter names that no longer match.
    const headers = [
      'Organization - Name',
      'Organization - Street/road name of Company Address',
      'Organization - Owner',
      'Organization - People',
      'Organization - ZIP/Postal code of Company Address',
      'Organization - Open deals',
      'Organization - Full/combined address of Company Address',
      'Organization - Last activity date',
      'Organization - Parent',
      'Organization - City/town/village/locality of Company Address',
      'Organization - Organization created',
      'Organization - Closed deals',
      'Organization - Lost deals',
      'Organization - Won deals',
    ];
    const m = detectPreset(headers);
    expect(m).not.toBeNull();
    expect(m?.preset.key).toBe('pipedrive-organizations');
  });

  it('detects a real Pipedrive Persons export with split email/phone columns', () => {
    // Modern Pipedrive Persons exports split email and phone by label
    // ("Person - Email - Work", "Person - Phone - Mobile", etc.) instead
    // of emitting a single "Person - Email" / "Person - Phone" column.
    // Detection has to fall back on always-present fields like
    // "Person - Organization" rather than "Person - Email".
    const headers = [
      'Person - Name',
      'Person - Email - Work',
      'Person - Email - Home',
      'Person - Email - Other',
      'Person - Organization',
      'Person - Open deals',
      'Person - Last activity date',
      'Person - Owner',
      'Person - Phone - Work',
      'Person - Phone - Home',
      'Person - Phone - Mobile',
      'Person - Phone - Other',
    ];
    const m = detectPreset(headers);
    expect(m).not.toBeNull();
    expect(m?.preset.key).toBe('pipedrive-persons');
  });

  it('detects a real Pipedrive Notes export', () => {
    // Captured verbatim from a 2026 Pipedrive Notes export. Required-
    // header set deliberately picks distinctively Pipedrive columns
    // ("Note is pinned to deal", "Add time") so a user-built CSV with
    // bare "ID" + "Content" columns does not trigger detection.
    const headers = [
      'ID',
      'Content',
      'Organization',
      'Organization ID',
      'Contact person',
      'Contact person ID',
      'Deal title',
      'Deal ID',
      'Add time',
      'Update time',
      'User',
      'Note is pinned to deal',
      'Note is pinned to organization',
      'Note is pinned to person',
      'Lead',
      'Lead ID',
      'Note is pinned to lead',
      'Project',
      'Note is pinned to project',
    ];
    const m = detectPreset(headers);
    expect(m).not.toBeNull();
    expect(m?.preset.key).toBe('pipedrive-notes');
  });

  it('does not detect a generic CSV with id+content columns as Pipedrive Notes', () => {
    // The required-header set must include enough Pipedrive-distinctive
    // columns that a user-built CSV with bare "id" / "content" / a
    // common timestamp column doesn't get falsely detected.
    const headers = ['ID', 'Content', 'Created at'];
    const m = detectPreset(headers);
    expect(m?.preset.key).not.toBe('pipedrive-notes');
  });

  it('detects a real custom-field-heavy Pipedrive Deals export', () => {
    // Captured from a workspace whose Deal record is mostly custom
    // fields — the only standard columns are Title, Stage, Pipeline,
    // Status, Creator, and the auto "Deal created" timestamp. Detection
    // still has to succeed on the (Title, Stage) pair.
    const headers = [
      'Deal - Title',
      'Deal - Is Agency?',
      'Deal - Agency Ever Paid?',
      'Deal - Pipeline',
      'Deal - Stage',
      'Deal - Drip Contact 1',
      'Deal - Drip Name 1',
      'Deal - Deal created',
      'Deal - Campaign (1) Direct',
      'Deal - Campaign (2) Direct',
      'Deal - Status',
      'Deal - Creator',
    ];
    const m = detectPreset(headers);
    expect(m).not.toBeNull();
    expect(m?.preset.key).toBe('pipedrive-deals');
  });

  it('chooses the highest-scoring preset on overlap', () => {
    const headers = [
      'First Name',
      'Last Name',
      'Email',
      'Phone Number',
      'Job Title',
      'Associated Company',
      'Record ID',
    ];
    const m = detectPreset(headers);
    expect(m?.preset.key).toBe('hubspot-contacts');
  });

  it('all bundled presets parse', () => {
    expect(PRESETS.length).toBeGreaterThan(0);
    for (const p of PRESETS) {
      expect(p.key).toBeTruthy();
      expect(['company', 'contact', 'deal', 'note']).toContain(p.entityType);
    }
  });
});

describe('applyPreset', () => {
  it('lays a preset over the actual CSV headers verbatim', () => {
    const preset = PRESETS.find((p) => p.key === 'pipedrive-persons')!;
    const headers = ['Person - Email', 'Person - Last name', 'Custom thing'];
    const m = applyPreset(preset, headers);
    expect(m['Person - Email']).toBe('email');
    expect(m['Person - Last name']).toBe('lastName');
    expect(m['Custom thing']).toBeNull();
  });
});
