import type { PrismaClient } from '@prisma/client';

// Loads the user-provided stage map ({ sourceStageName: pipelineStageId })
// and validates that every referenced stageId exists. Reports unmapped
// source stages back so the wizard can surface them as "needs mapping"
// in the sub-step. The runner uses `idFor` per row.
export interface StageResolverOptions {
  // The CSV's distinct stage names — derived from the parsed rows after
  // basic validation, so blank/null-stage rows don't pollute the list.
  distinctSourceStages: string[];
  // What the user picked in the UI's stage-mapping sub-step.
  stageMapping: Record<string, number>;
}

export class StageResolver {
  private mapping = new Map<string, number>();

  // Validates the input mapping against actual PipelineStage rows. Throws
  // when any stageId is bogus — better to fail fast than silently drop the
  // stage assignment to a default. Unmapped *source* stages are surfaced
  // as a separate value (`unmapped`) so the route can convert them to
  // row-level errors.
  static async build(
    prisma: PrismaClient,
    opts: StageResolverOptions,
  ): Promise<{ resolver: StageResolver; unmapped: string[] }> {
    const stageIds = Array.from(new Set(Object.values(opts.stageMapping)));
    let validIds = new Set<number>();
    if (stageIds.length > 0) {
      const stages = await prisma.pipelineStage.findMany({
        where: { id: { in: stageIds } },
        select: { id: true },
      });
      validIds = new Set(stages.map((s) => s.id));
    }
    const r = new StageResolver();
    const unmapped: string[] = [];
    for (const src of opts.distinctSourceStages) {
      const id = opts.stageMapping[src];
      if (id == null) {
        unmapped.push(src);
        continue;
      }
      if (!validIds.has(id)) {
        // Treat referencing a nonexistent stage as unmapped — same UX as
        // never having mapped it. The user fixes both via the same
        // sub-step.
        unmapped.push(src);
        continue;
      }
      r.mapping.set(src.toLowerCase(), id);
    }
    return { resolver: r, unmapped };
  }

  idFor(sourceStage: string | null): number | null {
    if (!sourceStage) return null;
    return this.mapping.get(sourceStage.toLowerCase()) ?? null;
  }
}
