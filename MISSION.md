# Mission: `@xtandard/audit`

You are the **lead** for a new project in the user's xtandard ecosystem. You own it end to end:
research, design, implementation, tests, docs, docs site, CI/CD and release prep. You may start and
coordinate your own worker agents through hc (see "Team"). **Do not stop until the Definition of
Done below is met**, or you are truly blocked on a decision only the user can make (then ask, and
keep working on everything that doesn't depend on the answer).

Your coordinator is the hc terminal **`t1r`** (the user's main Claude session). Report to it with
`hc send t1r "…"`. Its messages to you come tagged `<hc from="t1r …">`; treat them as instructions
from the user's side. This file is your brief: keep it, don't edit it (put your own plan in
`PLAN.md` and progress in `WORKLOG.md`, like the sibling repos do).

## What to build

An **embeddable, self-hosted, MIT-licensed audit-log control plane as a library**, for B2B SaaS apps:
the WorkOS Audit Logs / Retraced niche, in the exact shape of `@xtandard/flags` and
`@xtandard/webhooks`. Roughly:

- **Record** audit events from the app (actor, action, target(s), tenant/organization, context such
  as IP / user agent / request id, metadata, occurred-at), with a typed schema per action and
  validation. Async and batch-friendly; never lose events silently.
- **Store** them in pluggable storage (the same driver family as flags/webhooks: memory, file,
  sqlite, libsql, postgres, mysql via drizzle, mongodb, redis, unstorage, cloudflare-kv… pick what
  fits an append-heavy, query-heavy log) with retention policies.
- **Query** them: filter by actor, action, target, tenant, time range, free text; keyset pagination.
  Consider reusing `@xtandard/lib` filters + pagination (`/Users/santi/Projects/xtandard`) where it
  genuinely fits; the siblings are independent packages, so a dependency is a design decision, not a
  default.
- **Tamper evidence**: hash chain / signed batches so a customer or auditor can verify the log was
  not altered (a real differentiator; research how Retraced, Trillian-style logs, and WorkOS do it).
- **Customer-facing viewer**: an embeddable React portal so each tenant can browse, filter and export
  (CSV/JSON) its own events, scoped and authorized (like the webhooks consumer portal). Plus the
  admin UI for operators, like flags/webhooks have.
- **Streaming / export**: push events to SIEMs or sinks (webhook, HTTP, S3-like, Datadog/Splunk-style)
  — consider integrating with `@xtandard/webhooks` patterns.
- **Framework adapters** (Hono, Elysia, Express, Bun, …), **auth** (none/basic/delegated) and
  **authorization** (none/roles/delegated) modules, a **testing** entry, a **CLI**, `examples/`.
- Everything else flags/webhooks have that makes sense here.

### Study first (read, don't guess)

- `/Users/santi/Projects/xtandard-flags` and `/Users/santi/Projects/xtandard-webhooks`: copy their
  **architecture and conventions** — package layout and `exports`, storage driver interface and
  conformance tests, adapters, auth/authorization, admin UI + React embeds + portal, CLI, examples,
  ADRs, `CLAUDE.md`, README style (including the "The xtandard ecosystem" section), tooling
  (vite-plus / oxlint / oxfmt / vitest / playwright e2e), `docs/*.md` set, the Starlight docs site in
  `site/` + `pages.yml`, the release workflow (`release.yml`, npm **trusted publishing**), CI.
- `/Users/santi/Projects/drizzle-audit` (the user's existing `drizzle-audit` 0.1.13: Drizzle-level
  audit capture, storages, transforms, middleware for many frameworks). Reuse what is good; decide
  (in an ADR) how the two relate (capture layer vs control plane, a migration path, etc.). **Do not
  modify the drizzle-audit repo**; propose changes to t1r instead.
- `/Users/santi/Projects/xtandard` (`@xtandard/lib`) for filters, pagination, the sync/async-adaptive
  pattern (`docs/sync-async-adaptive.md`) and the docs-site setup.

### Research gate (do this first, report before building)

The user only builds what has no real open-source equivalent: permissive license (MIT/Apache, not
AGPL/SSPL/ELv2/FSL/"source-available"), actively maintained, AND the same **shape** (an embeddable
library, not just another standalone service). The coordinator's quick research found:
Retraced (Apache-2.0, small, last push 2026-08), BoxyHQ's audit module, and **AuditKit**
(auditkit.dev, claims open source + embeddable React viewer, source repo not found). WorkOS is paid.

Verify properly: search GitHub (topics, recent repos, last 12 months) and the web, read actual LICENSE
files, check activity, check shape. Write `docs/research/landscape.md` (alternatives, license,
activity, shape, what each lacks) and send t1r a short verdict. **If a permissive, maintained,
embeddable equivalent already exists, stop and report** instead of building. Otherwise continue
without waiting (t1r will interrupt you if the user disagrees).

## Team

- You may start worker agents with hc, e.g.
  `hc run --bg --name audit-<area> --cwd <worktree> claude --dangerously-skip-permissions "<exact task>. Report with hc send $HC_TERMINAL_ID when done or stuck."`
  Give each an exact scope and disjoint files, preferably its own git worktree. Workers must not
  start agents. Wait with `hc wait --children any`, read their results, review their diffs yourself,
  kill/rm them when done. Keep the number of parallel workers sensible (≈2–5).
- Read `hc --skill` once for the hc manual.

## Rules

- Repo: `/Users/santi/Projects/xtandard-audit` (already `git init`ed, branch main). Create the public
  GitHub repo `xantiagoma/xtandard-audit` (MIT) when there is something worth pushing; work through
  branches + PRs and merge your own PRs once CI is green (it's your repo). Conventional commits;
  end commit messages with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and PR bodies
  with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- Package name `@xtandard/audit`, version `0.x` (ZeroVer, like the siblings). Bun + the same toolchain.
- **Do not** publish to npm, change npm settings, or touch other repos without asking t1r. Preparing
  the release workflow and a dry run (`npm pack --dry-run`, publint) is in scope.
- GitHub Pages for the docs site (`https://me.xantiagoma.com/xtandard-audit/`) and the repo homepage
  are in scope once the site builds.
- Never put secrets in the repo. Keep the user's personal email out of anything public.
- Tests are not optional: unit, storage-driver conformance across drivers, adapter tests, browser/e2e
  for the UI and portal, type tests. `bun run check` and the full test suite green before calling
  anything done.

## Reporting to t1r

- After the research gate (verdict + path to landscape.md).
- After the design (path to PLAN.md + ADRs; a few lines on the main choices).
- At each milestone (repo created, core + storage, adapters, UI/portal, docs site live, release-ready),
  and at least every ~2 hours of work: what's done, what's next, anything risky.
- Questions that only the user can answer: `hc send t1r "QUESTION: …"` with options and your
  recommendation; keep working meanwhile.
- Keep messages under ~15 lines; long detail in files, send the path.

## Definition of Done

1. Research landscape + ADRs + PLAN.md committed.
2. `@xtandard/audit` implemented with the feature set above (or a documented, justified subset agreed
   with t1r), mirroring flags/webhooks structure; examples run.
3. All checks green locally and in GitHub Actions (lint, fmt, typecheck, unit, conformance, e2e).
4. README (with the ecosystem section), `docs/*.md`, `CLAUDE.md`, ADRs, CHANGELOG.
5. Docs site live at `https://me.xantiagoma.com/xtandard-audit/` (guides + API reference + ecosystem).
6. Release workflow with npm trusted publishing ready; `npm pack --dry-run` clean. Then send t1r:
   "READY TO PUBLISH" with what the user must do for the first npm publish.
7. A list (or ready branches, not PRs) of the one-line ecosystem-table additions for the five sibling
   repos (xtandard, xtandard-flags, xtandard-webhooks, xyte, xtandard-image), for t1r to apply.
8. Final report to t1r: what exists, where, how to verify it, known gaps.
