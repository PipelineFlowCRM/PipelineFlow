import type { PrismaClient } from '@prisma/client';

// Resolves source-CSV stage names to PipelineStage ids. Two layers of
// matching, in order:
//   1. The user's explicit `stageMapping` (the wizard's sub-step) — wins
//      whenever set, including when it points at a different PF stage
//      than the auto-match would have picked.
//   2. Case-insensitive auto-match against existing PipelineStage names
//      — handles the common "I already created the stages in
//      PipelineFlow with the same names" path so the user doesn't have
//      to re-pick them in the sub-step.
//
// Sources that resolve neither way go into `unmapped`, and the route
// converts them into row-level errors. `autoMapped` is exposed so the
// wizard can pre-fill its sub-step dropdowns with the auto-resolved
// values for the user to verify or override.
export interface StageResolverOptions {
  // The CSV's distinct stage names — derived from the parsed rows after
  // basic validation, so blank/null-stage rows don't pollute the list.
  distinctSourceStages: string[];
  // What the user picked in the UI's stage-mapping sub-step. Empty
  // object on the first dry-run.
  stageMapping: Record<string, number>;
}

export interface StageResolverBuildResult {
  resolver: StageResolver;
  unmapped: string[];
  // Source-stage → PipelineStage.id that the resolver picked
  // automatically (i.e. without user input). The wizard merges these
  // into its `stageMapping` state so the sub-step's dropdowns show the
  // auto-resolved selections instead of a sea of "Unmapped" rows.
  autoMapped: Record<string, number>;
}

export class StageResolver {
  private mapping = new Map<string, number>();

  static async build(
    prisma: PrismaClient,
    opts: StageResolverOptions,
  ): Promise<StageResolverBuildResult> {
    // Skip the DB hit for non-Deal imports or Deal imports where every
    // row's stageName is blank/null — the validators have already
    // produced row-level errors and there's no resolution work to do.
    if (opts.distinctSourceStages.length === 0) {
      return { resolver: new StageResolver(), unmapped: [], autoMapped: {} };
    }

    // Load all PF stages for both the user-pick validity check and the
    // name-match fallback in one pass. A pipeline rarely has more than
    // a dozen stages — full table is cheaper than two separate queries.
    const allStages = await prisma.pipelineStage.findMany({
      select: { id: true, name: true },
    });
    const validIds = new Set(allStages.map((s) => s.id));

    // Build the name-match index. The schema doesn't enforce stage-name
    // uniqueness, so we tally counts per normalized name and skip
    // auto-matching whenever a name appears more than once. Forcing the
    // user to pick via the sub-step is safer than silently binding to
    // a non-deterministic "first row by id" stage.
    const nameCounts = new Map<string, number>();
    const stagesByName = new Map<string, number>();
    for (const s of allStages) {
      const key = s.name.trim().toLowerCase();
      nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
      // Only set the first occurrence; second occurrence will be
      // disqualified below by the count check.
      if (!stagesByName.has(key)) stagesByName.set(key, s.id);
    }
    for (const [key, count] of nameCounts) {
      if (count > 1) stagesByName.delete(key);
    }

    const r = new StageResolver();
    const unmapped: string[] = [];
    const autoMapped: Record<string, number> = {};

    for (const src of opts.distinctSourceStages) {
      // 1) explicit user mapping wins
      const explicitId = opts.stageMapping[src];
      if (explicitId != null) {
        if (!validIds.has(explicitId)) {
          // User picked a stage that no longer exists (deleted between
          // dry-runs). Surface as unmapped so the sub-step re-prompts.
          unmapped.push(src);
          continue;
        }
        r.mapping.set(src.toLowerCase(), explicitId);
        continue;
      }
      // 2) auto-match by case-insensitive PF stage name
      const autoId = stagesByName.get(src.trim().toLowerCase());
      if (autoId != null) {
        r.mapping.set(src.toLowerCase(), autoId);
        autoMapped[src] = autoId;
        continue;
      }
      unmapped.push(src);
    }
    return { resolver: r, unmapped, autoMapped };
  }

  idFor(sourceStage: string | null): number | null {
    if (!sourceStage) return null;
    return this.mapping.get(sourceStage.toLowerCase()) ?? null;
  }
}
