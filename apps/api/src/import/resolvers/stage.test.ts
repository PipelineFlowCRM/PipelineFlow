import { describe, expect, it } from 'vitest';
import { StageResolver } from './stage.js';

// Minimal prisma stub. The real PrismaClient would require a live DB;
// the resolver only ever calls `pipelineStage.findMany` so we mock just
// that surface and keep the test units focused on the resolution logic.
function fakePrisma(stages: { id: number; name: string }[]) {
  return {
    pipelineStage: {
      findMany: async () => stages,
    },
  } as unknown as Parameters<typeof StageResolver.build>[0];
}

describe('StageResolver.build', () => {
  it('auto-matches source stages to existing PF stages by case-insensitive name', async () => {
    const prisma = fakePrisma([
      { id: 10, name: 'Qualified' },
      { id: 11, name: 'Proposal Sent' },
    ]);
    const built = await StageResolver.build(prisma, {
      distinctSourceStages: ['QUALIFIED', 'proposal sent'],
      stageMapping: {},
    });
    expect(built.unmapped).toEqual([]);
    expect(built.autoMapped).toEqual({ QUALIFIED: 10, 'proposal sent': 11 });
    expect(built.resolver.idFor('Qualified')).toBe(10);
    expect(built.resolver.idFor('Proposal Sent')).toBe(11);
  });

  it('user-supplied stageMapping wins over an auto-match', async () => {
    const prisma = fakePrisma([
      { id: 10, name: 'Qualified' },
      { id: 99, name: 'Custom Override' },
    ]);
    const built = await StageResolver.build(prisma, {
      distinctSourceStages: ['Qualified'],
      // User explicitly mapped "Qualified" to a different stage even
      // though there's a name match. The explicit pick must win.
      stageMapping: { Qualified: 99 },
    });
    expect(built.unmapped).toEqual([]);
    // autoMapped only lists the *auto-resolved* ones, not the explicit
    // pick — so the wizard knows which dropdowns it has authored.
    expect(built.autoMapped).toEqual({});
    expect(built.resolver.idFor('Qualified')).toBe(99);
  });

  it('flags genuinely unmapped stages', async () => {
    const prisma = fakePrisma([{ id: 10, name: 'Qualified' }]);
    const built = await StageResolver.build(prisma, {
      distinctSourceStages: ['Qualified', 'Mystery Stage'],
      stageMapping: {},
    });
    expect(built.unmapped).toEqual(['Mystery Stage']);
    expect(built.autoMapped).toEqual({ Qualified: 10 });
  });

  it('treats a user pick at a now-deleted stageId as unmapped', async () => {
    const prisma = fakePrisma([{ id: 10, name: 'Qualified' }]);
    const built = await StageResolver.build(prisma, {
      distinctSourceStages: ['Qualified'],
      // 999 doesn't exist in the fakePrisma stages list.
      stageMapping: { Qualified: 999 },
    });
    expect(built.unmapped).toEqual(['Qualified']);
  });

  it('skips the DB query when no source stages are present', async () => {
    // Empty distinctSourceStages should short-circuit before findMany.
    let findManyCalled = false;
    const prisma = {
      pipelineStage: {
        findMany: async () => {
          findManyCalled = true;
          return [];
        },
      },
    } as unknown as Parameters<typeof StageResolver.build>[0];
    const built = await StageResolver.build(prisma, {
      distinctSourceStages: [],
      stageMapping: {},
    });
    expect(findManyCalled).toBe(false);
    expect(built.unmapped).toEqual([]);
    expect(built.autoMapped).toEqual({});
  });

  it('does NOT auto-match when the PF stage name is duplicated', async () => {
    // Two PF stages share the same name (schema allows this). Picking
    // either silently is non-deterministic — force the user to pick.
    const prisma = fakePrisma([
      { id: 10, name: 'Qualified' },
      { id: 20, name: 'qualified' }, // case-insensitive dup
      { id: 30, name: 'Closed Won' },
    ]);
    const built = await StageResolver.build(prisma, {
      distinctSourceStages: ['Qualified', 'Closed Won'],
      stageMapping: {},
    });
    // 'Qualified' has two case-insensitive matches → not auto-matched.
    expect(built.autoMapped).toEqual({ 'Closed Won': 30 });
    expect(built.unmapped).toEqual(['Qualified']);
  });
});
