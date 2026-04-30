# Contributing to PipelineFlow

Thanks for taking the time. This is a small project; please keep PRs focused and the change set tight.

## Ground rules

- **Single-tenant by design.** Any signed-in user shares one workspace. PRs that introduce per-user ACLs / multi-tenancy need design discussion first — open an issue before coding.
- **Code style:** prefer editing existing files over creating new ones. Don't add abstractions for hypothetical future requirements. Comments explain *why*, not *what*.
- **No backwards-compat shims** for unreleased features — until we cut a `1.0`, breaking changes in the schema or API are fair game with a clear migration note.

## Setup

Requires **Node 20+**, **pnpm 9+**, and **Docker** (for Postgres).

```bash
git clone https://github.com/<your-fork>/pipelineflow.git
cd pipelineflow
pnpm install

cp .env.example .env
cp apps/api/.env.example apps/api/.env

docker compose up -d postgres
pnpm --filter @pipelineflow/api run prisma:migrate:dev
pnpm --filter @pipelineflow/api run prisma:seed
pnpm dev
```

Visit `http://localhost:5173` and log in as `demo@pipelineflow.app` / `demo1234`.

## Project layout

```
apps/api/         — Express + Prisma backend
apps/web/         — Vite React SPA
packages/shared/  — Zod schemas + DTO types shared across api + web
```

The shared package is the **source of truth for request/response shapes**. If you add a new endpoint, define the input schema there and import it from the route. The web side imports the inferred TS type, so client + server never drift.

## Running checks

| Command | What it does |
| --- | --- |
| `pnpm lint` | Type-check both packages (no emit) |
| `pnpm test` | Run all vitest unit tests |
| `pnpm build` | Build everything; will fail on type errors |

CI will run all three on every PR. **Please run them locally first.**

## Tests

We have unit tests for the security-critical pure functions (`auth/password`, `lib/csv`, `lib/s3.dispositionHeader`, `lib/issuedKeys`). We do **not** yet have route-level integration tests (no Postgres test container wired up). If you're touching auth, sessions, or anything that signs URLs, please add unit tests for the helpers and call out in the PR description what manual testing you did.

Co-located test files: `<thing>.test.ts` next to `<thing>.ts` is the convention.

## Database changes

Schema changes go through Prisma migrations:

```bash
# After editing prisma/schema.prisma
pnpm --filter @pipelineflow/api run prisma:migrate:dev --name short_descriptive_name
```

The generated SQL lives in `apps/api/prisma/migrations/<timestamp>_<name>/migration.sql` — review it, hand-edit if Prisma's generated SQL isn't quite right (e.g. for functional indexes, `CONCURRENTLY` builds, or backfill steps), and commit it together with the schema change.

**Production migrations run automatically** at api container start (`prisma migrate deploy` in the Dockerfile CMD). Don't write migrations that depend on online application code being a specific version — they should be safely re-runnable from any prior state.

## Pull requests

- One concern per PR. Refactor + feature in the same diff is hard to review.
- The PR description should answer: **what changed**, **why**, and **how to verify**.
- Reference any related issue with `Closes #N`.
- Keep diffs small. If you find adjacent issues, jot them in the PR body and open a follow-up rather than expanding scope.

## Reporting security issues

Please **don't** open a public issue for security problems. Email the maintainer instead — the address is on the GitHub profile. We'll acknowledge within a few days and coordinate a disclosure timeline.

## License

By contributing, you agree that your contributions will be licensed under the [Mozilla Public License 2.0](./LICENSE), the same license as the rest of the project. MPL is file-level copyleft, so modifications you make to existing MPL-licensed files must themselves be released under the MPL when redistributed.
