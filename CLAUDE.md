# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# dependabot-alert-triage

A public GitHub Action that dismisses Dependabot alerts matching user-defined rules (manifest path, ecosystem, package, and classification), with a required reason and comment. It exists because GitHub cannot exclude directories from alert scanning. Intended usage: `uses: pokutuna/dependabot-alert-triage@v1` on `schedule` / `workflow_dispatch`.

## Tech stack

- TypeScript JavaScript action (not composite): `action.yml` at the repository root, entrypoint `src/index.ts` (a thin wrapper so `src/main.ts` stays importable in tests), bundled to a committed `dist/index.js`
- `@actions/core` and `@actions/github` (Octokit) for I/O and the Dependabot alerts API
- `zod` + `yaml` for the rule file, `picomatch` for glob matching
- npm and `vitest`; keep rule matching and dry-run/apply decisions as pure functions

## Essential commands

- Test: `npm test` (single file: `npx vitest run src/triage.test.ts`)
- Typecheck: `npm run typecheck`
- Lint / Format: `npm run lint` (oxlint), `npm run fmt` (oxfmt; CI checks with `npm run fmt:check`)
- Build the bundle: `npm run build` (regenerate `dist/` and commit it whenever `src/` changes)

## Core rules

- Write commit messages, code comments, and documentation in English.
- Safety invariants are non-negotiable: dismiss only `open` alerts, never send a PATCH request under `dry_run`, re-verify each alert right before the PATCH request, cap dismissals per run, and never touch malware alerts unless a rule explicitly opts in.
- The Action takes a `token` input and never embeds credentials. `GITHUB_TOKEN` can only read alerts; applying requires a GitHub App installation token or a fine-grained personal access token with Dependabot alerts write access.

## Documentation

- docs/design.md (local notes, not committed) — dismissal API mechanics, rule semantics (AND within a rule, OR across rules), safety invariants, token model, and release conventions. When present, read it before changing matching or dismissal logic. README.md covers the user-facing behavior and rule format.
