# dependabot-alert-triage

> [!IMPORTANT]
> This Action is under development and has no release yet. `@v1` in the examples does not exist. To try it now, reference `pokutuna/dependabot-alert-triage@main` — but only with a read-only token and `dry_run: true`. Before passing a write-capable token, pin to a full-length commit SHA you have reviewed.

A GitHub Action that dismisses Dependabot alerts matching rules defined in your repository, with a required reason and comment.

GitHub provides no way to exclude directories from Dependabot alert scanning. The `.github/dependabot.yml` options only control version-update pull requests, not the Dependency Graph or alerts. This Action fills the gap: you keep tracking alerts for the whole repository, and dismiss only the alerts you have decided to accept — for example, dependencies under an `experiments/` directory that you can't update.

Dismissal does not change what gets scanned. New advisories still create new alerts, and this Action triages them again on the next run.

## Features

- Matches open alerts by manifest path (glob), ecosystem, package name, and classification, using rules stored in your repository.
- Dismisses each matching alert with the reason and comment written in the rule, so the decision stays reviewable in version control.
- Reports every candidate to the job summary before touching anything.
- Supports a dry run that only reports candidates and never updates an alert.
- Applies safeguards on every run: it re-verifies each alert immediately before dismissal, fails without updating anything when candidates exceed `max_dismissals`, and never dismisses malware alerts unless a rule opts in explicitly.

## Setup

### 1. Create the rule file

Create `.github/dependabot-triage.yml` in your repository:

```yaml
rules:
  - match:
      manifest_path: "experiments/**"
      packages:
        pip:
          - torch
    classification: general
    reason: tolerable_risk
    comment: torch cannot be updated in the experiment environment
```

Rules follow these semantics:

- Conditions within one rule are AND; multiple rules combine as OR. The first matching rule wins for each alert.
- All match conditions are optional; an omitted condition means "no restriction". A rule without `packages` targets everything under its manifest path; a rule without `manifest_path` targets the packages across the repository.
- `manifest_path` is a glob matched against the alert's manifest path, such as `experiments/**`.
- `packages` maps an ecosystem (`npm`, `pip`, and so on) to exact package names.
- `reason` and `comment` are required. `reason` must be one of `fix_started`, `inaccurate`, `no_bandwidth`, `not_used`, or `tolerable_risk`. Pick the reason that reflects reality.
- `classification` defaults to `general`. Malware alerts are never dismissed unless a rule sets `classification: malware` explicitly.

A package-level rule also matches advisories published in the future. Record the accepted-risk rationale in the comment.

### 2. Prepare a token

The Action never embeds credentials; it uses only the token you pass:

- The workflow `GITHUB_TOKEN` can read alerts when the workflow grants `vulnerability-alerts: read`, but it can never dismiss them — GitHub Actions offers no write access for that permission. It is sufficient only for a dry run.
- Dismissing requires a token with Dependabot alerts read and write access: a GitHub App installation token (recommended; generate it per run with [`actions/create-github-app-token`](https://github.com/actions/create-github-app-token)) or a fine-grained personal access token.

To use a GitHub App, register one, set its repository permission "Dependabot alerts" to "Read and write", and install it on the target repository only. Then store the client ID as a repository variable and the private key as a repository secret.

### 3. Add the workflow

Create a workflow that you can run manually. Starting with `workflow_dispatch` only lets you verify the rules before any automated run:

```yaml
name: Dependabot triage

on:
  workflow_dispatch:
    inputs:
      dry_run:
        description: Only report matching alerts
        type: boolean
        default: true

permissions:
  contents: read

jobs:
  triage:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/create-github-app-token@v3
        id: app-token
        with:
          client-id: ${{ vars.DEPENDABOT_TRIAGE_APP_CLIENT_ID }}
          private-key: ${{ secrets.DEPENDABOT_TRIAGE_APP_PRIVATE_KEY }}
          owner: ${{ github.repository_owner }}
          repositories: ${{ github.event.repository.name }}

      - uses: actions/checkout@v4
        with:
          persist-credentials: false

      - uses: pokutuna/dependabot-alert-triage@v1
        with:
          token: ${{ steps.app-token.outputs.token }}
          dry_run: ${{ inputs.dry_run }}
```

The checkout step is required because the Action reads the rule file from your repository.

## Try it manually first

Before automating anything, confirm that the rules select exactly the alerts you expect:

1. Run the workflow from the **Actions** tab with `dry_run` set to `true` (the default in the preceding example).
2. Open the job summary and review the candidate list: alert number, manifest path, package, classification, severity, and reason.
3. If the list contains unexpected alerts, narrow the rules and repeat the dry run.
4. Run the workflow again with `dry_run` set to `false`. The Action dismisses the candidates and reports the result in the job summary.
5. Check the dismissed alerts on the repository's **Security** tab. You can reopen any alert manually if needed.

## Run on a schedule

After the manual runs behave as expected, add a `schedule` trigger and change the `dry_run` default to `false`:

```yaml
on:
  schedule:
    - cron: "0 3 * * *"
  workflow_dispatch:
    inputs:
      dry_run:
        description: Only report matching alerts
        type: boolean
        default: false
```

Pass `dry_run: ${{ inputs.dry_run || false }}` to the Action, because `inputs` is empty on scheduled runs. Scheduled runs then apply the rules daily, and you can still start a manual dry run with `dry_run` set to `true` at any time.

Pin the Action to a full-length commit SHA or a release tag in workflows that pass a write-capable token.

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `token` | Yes | — | Token used to read and update Dependabot alerts |
| `dry_run` | No | `false` | Only report matching alerts without dismissing them |
| `config` | No | `.github/dependabot-triage.yml` | Path to the rule file |
| `max_dismissals` | No | `20` | Maximum number of alerts to dismiss in one run |

## Outputs

| Output | Description |
|---|---|
| `candidates_count` | Number of open alerts that matched a rule |
| `dismissed_count` | Number of alerts that were dismissed |

## Safety behavior

The Action applies these safeguards on every run:

- Only `state == open` alerts are candidates.
- When `dry_run` is `true`, the Action reports candidates to the job summary and never updates an alert.
- The candidate list is written to the job summary before applying.
- Before each dismissal, the Action re-fetches the alert and re-verifies that it still matches the rule; alerts that changed are skipped.
- If the number of candidates exceeds `max_dismissals`, the run fails without updating anything. This bounds the damage of a bad rule edit.

Repositories with the "Prevent direct alert dismissals" setting enabled reject direct dismissals. This Action does not support the dismissal-request flow that such repositories require.
