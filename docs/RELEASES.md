# Releases

ZeroVer (`0.x`): the API is stabilizing; minor bumps may break, patch bumps don't. Releases are cut manually — the proven flow below, **not** `changelogen --release` (its auto-tag once tagged a pre-bump commit in the sibling flags repo).

## The first publish (once)

npm only lets you configure a trusted publisher on a package that exists, so `v0.1.0` is published by
hand from a maintainer's machine, and every later version goes through `release.yml`:

```sh
git checkout v0.1.0 && bun install --frozen-lockfile
bun run build && bunx publint && bun pm pack --dry-run   # what will ship
npm publish --access public --provenance=false           # 2FA prompt; provenance needs CI
# then, once, allow this repo's workflow to publish:
npx npm@latest trust github @xtandard/audit --repo xantiagoma/xtandard-audit --file release.yml --allow-publish
gh release create v0.1.0 --title v0.1.0 --notes-file <(awk '/^## v0.1.0/{on=1;next} on&&/^## /{exit} on' CHANGELOG.md)
```

## The flow

```sh
export NODE_OPTIONS=            # a stale preload breaks husky under node

# 1. Preview the changelog since the last tag
bunx changelogen --from vPREV --to HEAD

# 2. Bump + record
npm pkg set version=X.Y.Z      # also bump VERSION in src/version.ts
#    prepend the CHANGELOG.md entry from the preview
bun run format                  # ALWAYS before committing, even docs-only
git add -A && git commit -m "chore(release): vX.Y.Z"

# 3. Tag and push — main FIRST, tag second
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin main
git push origin vX.Y.Z

# 4. Verify the tag dereferences to the release commit
git ls-remote origin 'refs/tags/vX.Y.Z^{}'

# 5. Watch the Release workflow (build → publint → npm publish --provenance → GitHub Release)
gh run watch

# 6. Confirm
npm view @xtandard/audit version
```

Requirements: npm **trusted publishing** (OIDC) for this repo + `release.yml` — no token to store or rotate — and `.npmrc` keeps `provenance=true`. Set the trust up once (npm >= 11.10, logged in as a package owner):

```sh
npx npm@latest trust github @xtandard/audit --repo xantiagoma/xtandard-audit --file release.yml --allow-publish
```

**Publish failed for a tag?** Re-run it without cutting a new version: `gh workflow run release.yml -f tag=vX.Y.Z`.

## Conventional commits

Scopes: `core`, `integrity`, `query`, `recorder`, `streams`, `sinks`, `storage`, `server`, `ui`, `react`, `portal`, `cli`, `examples`, `docs`, `site`, `ci`. The changelog is generated from these — write them for the reader.
