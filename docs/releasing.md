# Releasing spawn-ts

One command decides everything: **pushing a `v*` tag publishes to npm.** That is
irreversible — npm forbids republishing a version even after `npm unpublish` — so
everything below exists to make the tag the *last* step rather than the first.

## The rules

1. **`package.json` version, the CHANGELOG section, and the tag must agree.**
   `publish.yml` already refuses a tag that disagrees with `package.json`; the
   CHANGELOG is checked by `npm run release:check`.
2. **Every published version has a CHANGELOG section and a git tag.** Both 0.6.0
   and 0.6.1 shipped without sections, and 0.6.0 was never tagged — so
   `[Unreleased]` still read `compare/v0.5.0...HEAD` and accumulated items that
   had already shipped. A reader could not tell what they were running.
3. **spawn-ts stays on `0.x.y` indefinitely.** There is no planned 1.0.0, so a
   MINOR bump means "may break you" permanently, not as a pre-release convention.
   Read the version line as its own, deliberately not Go `spawn`'s — see the
   CHANGELOG preamble.
4. **MINOR when observable behaviour changes for an existing caller**, even if no
   type changed. 0.7.0 is MINOR because `launch` began *refusing* a spec it used
   to accept (#51) and the launch guard changed which options satisfy it (#55).
   A type-compatible change that rejects previously-valid input is a break.
5. **Tag from `main`, never from a branch**, and only with a green CI run on the
   exact commit being tagged.

## The process

```bash
# 0. on main, up to date, clean, and green
git switch main && git pull --ff-only
gh run list --branch main --limit 1        # the head commit must be green

# 1. bump the version (no tag yet — npm version would create one)
npm version 0.7.0 --no-git-tag-version

#    ...and LIB_VERSION in src/core/tags.ts, which must match. It is
#    hand-maintained on purpose: a browser library can't read package.json at
#    runtime, and importing src/index.ts there would be circular. It is stamped
#    into the spawn:version launch tag and read by Go's pkg/aws/ami_mgmt.go, so a
#    stale value mislabels every instance launched. `release:check` fails on a
#    mismatch (tags.test.ts) rather than trusting anyone to remember.

# 2. promote [Unreleased] → [0.7.0] — dated, with a compare link at the bottom,
#    and leave a fresh "## [Unreleased]" above it saying "Nothing yet."

# 3. preflight: version/CHANGELOG/tag agreement + typecheck + test + build
npm run release:check

# 4. commit and push the bump BEFORE tagging, so the tag lands on a pushed commit
git commit -am "chore(release): 0.7.0"
git push

# 5. tag — this is the irreversible step
git tag -a v0.7.0 -m "spawn-ts 0.7.0"
git push origin v0.7.0

# 6. verify the publish actually happened
gh run watch                               # publish.yml
npm view @spore-host/spawn-ts dist-tags
gh release create v0.7.0 --notes-from-tag  # or --notes-file with the section
```

Steps 4 and 5 are separate on purpose: a tag pointing at an unpushed commit
publishes a tree nobody can review.

## What `release:check` verifies

It is a preflight, not a formality — each check corresponds to a drift that has
actually happened in this repo:

| check | the drift it prevents |
|---|---|
| `package.json` version has a matching `## [x.y.z]` section | 0.6.0 and 0.6.1 shipped with none |
| that section is dated and not `[Unreleased]` | publishing a version whose notes are still a draft |
| a `[x.y.z]:` compare link exists at the bottom | the link list stopping at 0.5.0 |
| the version is not already published to npm | a tag that fails at the publish step |
| the version is not already tagged | silently re-tagging a released commit |
| `[Unreleased]` compares from the newest released tag | items that already shipped sitting in `[Unreleased]` |
| typecheck + test + build:lib pass | shipping a broken `dist/` |
| `LIB_VERSION` matches (via `tags.test.ts`) | a stale `spawn:version` on every launched instance |
| every `exports` target exists in `dist/` | a consumer's import resolving to nothing — the list in `publish.yml` had already gone stale, missing `./transfer` |

## If a publish fails after the tag is pushed

Do **not** move the published tag. Fix forward and cut the next patch — this is
what happened to truffle-ts v0.4.1 (a Node-version failure in the workflow), where
0.4.2 was cut on the fixed HEAD and the v0.4.1 tag was left as a harmless no-op.
Moving a tag that consumers or provenance may already reference is worse than an
unused version number.

## Notes

- **The npm read path lags the write path** by minutes for a fresh version.
  `npm dist-tags` and the workflow's own success are authoritative; do not conclude
  failure from `npm view` alone.
- **No credential can publish.** The package is set to "require 2FA and disallow
  tokens", and the only authorized publisher is this repo's `publish.yml` via OIDC.
  There is no token to add and nothing to rotate.
- The first publish of a *new* package cannot use Trusted Publishing (it is
  configured per-package, post-publish) and must be done manually. That is already
  done for this package.
