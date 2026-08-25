# Release process

## Release a new version

Wait for CI to pass on `main`, then run the following, replacing `0.2.0` with
the version to release:

```
npm version 0.2.0 --no-git-tag-version
npm run build
git commit -am "chore: release v0.2.0"
git push
```

Wait for CI to pass on that commit, then push the tag:

```
git tag v0.2.0
git push origin v0.2.0
```

## What the tag push does

`.github/workflows/release.yml` runs on `vX.Y.Z` tags and does three things:

1. Rejects the tag if it isn't an ancestor of `main`, so a tag pushed from an
   unreviewed branch can't be released.
1. Creates the GitHub release with generated notes, marked as a prerelease
   while the version is below `v1.0.0`.
1. Moves the major tag (`v0`) to the tagged commit, but only if no newer
   `v0.*.*` tag exists. GitHub Actions has no version range syntax, so a moving
   major tag is the only way consumers using `@v0` receive patches — which also
   means a tag that moved backwards would downgrade all of them.

It doesn't build or test. CI covers that, including whether the committed
`dist/` matches `src/`.

## Roll back a broken release

Point the major tag back at the last working release. The workflow only moves it
forward, so do it directly:

```
git tag -f v0 v0.1.0
git push -f origin v0
```

Leave the broken `vX.Y.Z` tag in place, because deleting it breaks any consumer
that pinned it. Release the fix as a new patch version instead.
