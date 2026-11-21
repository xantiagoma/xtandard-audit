# @xtandard/audit

Self-hosted, embeddable, tamper-evident audit-log control plane for B2B SaaS, as a library. Bun for
tooling; `bun run check && bun run test && bun run test:bun` is the gate (`bun run format` before
committing). Structure, naming and docs mirror `xtandard-webhooks` and `xtandard-flags`; every
deviation is an ADR in `docs/ADR` (★ in PLAN.md's index).

## Invariants (break one and verification breaks for real customers)

- The integrity format (`src/integrity.ts`, `src/canonical.ts`) is a wire contract: never change what
  is hashed or how without bumping `integrity.v` / checkpoint `v` and keeping the old verifier path.
- `record()` throws rather than silently dropping (ADR 0002); the recorder never drops without
  calling `onError`.
- Retention only removes chain **prefixes** and writes a `base` checkpoint; streams hold it back.
- Every storage driver passes `test/storage-contract.ts` (`runStorageContractTests`); native
  `queryEvents` must agree with `matchesQuery` in `src/query.ts`.
- New subpath = `src/entry-*.ts` (with `@module`), `vite.config.ts` `pack.entry`, `package.json`
  `exports`, `examples/tsconfig.json` `paths`, and `site/manifest.ts` if it needs a page.

## Shared machine

Heavy jobs (full suites, coverage, tsc, builds, docs:build, Playwright) go through
`HEAVY_SLOTS=3 /Users/santi/Projects/xtandard-missions/heavy.sh <cmd>` on the maintainer's machine.

## Docs Site

`site/` is an Astro Starlight site (own `package.json`/lockfile, not published) deployed by
`.github/workflows/pages.yml` to https://me.xantiagoma.com/xtandard-audit/.

- `README.md` and `docs/*.md` stay the source of truth (they render on GitHub/npm).
  `site/scripts/sync.ts` copies them into `site/src/content/docs/` (generated, gitignored); README
  sections become pages per `site/manifest.ts` — so **renaming an H2 in `README.md` that the
  manifest lists, or adding/renaming a file in `docs/`, needs `site/manifest.ts` updated** (sync
  fails loudly otherwise). Relative links between docs are rewritten to site routes. Every
  `docs/ADR/NNNN-*.md` becomes a page by itself (short sidebar labels in `adrLabels`). A guide
  still being written elsewhere is a `pending` manifest entry (today only `CHANGELOG.md`, which
  changelogen writes on the first release): left out, with links to it going to GitHub, until the
  file exists.
- Site-only pages (the home page) live in `site/content/`. Branding (docs/BRAND.md): the
  horizontal lockups in the header, the favicon set and `social.png` as `og:image`; sync copies
  those files from `docs/assets/` into `site/public/` (gitignored), and the palette is
  `site/src/styles/brand.css`.
- The API reference is generated from `src/` by starlight-typedoc, one module per `exports` entry
  in `package.json` (`entries()` in `site/manifest.ts`). Each entry file (`src/index.ts`,
  `src/core.ts`, `src/entry-*.ts`, …) starts with a `@module <name>` doc comment that names and
  describes its page; `site/scripts/api-overviews.ts` writes `/api/` and `/api/<module>/`.
- `bun run docs:dev` / `docs:build` / `docs:preview` (port 4326). Astro runs under Bun
  (`bun --bun astro …`); `.mdx` is excluded from `vp fmt` (it mangles MDX). The build fails on
  any broken internal link.
