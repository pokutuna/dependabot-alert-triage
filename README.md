# dependabot-alert-triage

A GitHub Action that dismisses Dependabot alerts that match rules stored in your repository.

You can't act on every alert. A lock file might belong to temporary or experimental code that you never publish, or a package might be pinned to a version that you can't upgrade. Those alerts stay open and bury the ones that need attention. The `ignore` and `directories` options in `.github/dependabot.yml` don't help, because they affect version update pull requests only, not the Dependency Graph or the alerts.

Dependabot keeps scanning the whole repository. This Action dismisses only the alerts that you already decided to accept, so new advisories still open new alerts, and the next run triages them again.

## Features

- Match alerts by manifest path, ecosystem, package name, and classification.
- Keep the rules, the dismissal reasons, and the comments in version control.
- Review the candidates in the job summary before you dismiss anything.

Dismissing an alert changes its state, so the Action applies several safeguards on every run. For more information, see [Safety behavior](#safety-behavior).

## Setup

### Create the rule file

Create `.github/dependabot-triage.yml` in your repository:

```yaml
rules:
  # Everything under sketch/ is a scratch notebook that never ships.
  - match:
      manifest_path: "sketch/**"
    reason: not_used
    comment: >-
      sketch/ holds experiments that are never deployed or published, so
      nothing here runs where an attacker could reach it.

  # One pinned package, anywhere in the repository.
  - match:
      packages:
        pip:
          - torch
    reason: tolerable_risk
    comment: >-
      torch is pinned to 2.1 for CUDA 11.8 compatibility. The advisory needs
      an untrusted model file, and we load only models we build ourselves.
```

An alert must satisfy every condition in `match`, an omitted condition matches anything, and the first matching rule in the file decides the dismissal.

| Field | Example | Description |
|---|---|---|
| `match.manifest_path` | `"sketch/**"` | Glob for the manifest that reported the alert |
| `match.packages.<ecosystem>` | `["@react-router/*"]` | Package-name globs. `<ecosystem>` is the exact [`dependency.package.ecosystem`](https://docs.github.com/en/rest/dependabot/alerts?apiVersion=2022-11-28#list-dependabot-alerts-for-a-repository) value, such as `npm` |
| `classification` | `malware` | `general` (the default) or `malware` |
| `reason` | `not_used` | Required. `fix_started`, `inaccurate`, `no_bandwidth`, `not_used`, or `tolerable_risk` |
| `comment` | `"Never deployed."` | Required. Text that GitHub records with the dismissal |

In `match.packages`, any glob listed for the alert's own ecosystem can match its package name. A rule with no condition matches every open `general` alert, so write one only as a deliberate catch-all and place it last.

The Action validates the rule file strictly, so a typo fails the run instead of matching nothing. A package rule also matches future advisories for that package, so explain the accepted risk in the comment.

#### Glob patterns

`manifest_path` and package names accept glob patterns. A glob matches the whole value that the alert reports, and a pattern without glob characters is an exact, case-sensitive match. Manifest paths are relative to the repository root:

| Pattern | Matches | Doesn't match |
|---|---|---|
| `sketch/**` | `sketch/requirements.txt`, `sketch/foo/pnpm-lock.yaml` | `apps/sketch.lock` |
| `sketch/*` | `sketch/requirements.txt` | `sketch/foo/pnpm-lock.yaml` |
| `"@react-router/*"` | every package in that npm scope | `react-router` |

Quote a pattern that starts with `@` or `*` so that YAML doesn't misparse it.

### Prepare a token

The Action uses only the token that you pass in. A dry run needs just the workflow `GITHUB_TOKEN` and `vulnerability-alerts: read`. That token can't dismiss an alert, because GitHub Actions offers no write access for that permission.

To dismiss an alert, you need a token with read and write access to Dependabot alerts. You can use either of the following:

- **GitHub App installation token**: recommended, because it isn't tied to an individual account and it expires after each run. [Register an App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app) with the **Dependabot alerts** repository permission set to **Read and write**, [install it](https://docs.github.com/en/apps/using-github-apps/installing-your-own-github-app) on the target repository only, and store the client ID as a repository variable and the private key as a repository secret for [`actions/create-github-app-token`](https://github.com/actions/create-github-app-token).
- **Fine-grained personal access token**: [create a token](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-fine-grained-personal-access-token) with read and write access to **Dependabot alerts** on the target repository, and store it as a repository secret.

### Add the workflow

To verify the rules before any automated run, create a workflow with only `workflow_dispatch`:

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
      # With a PAT instead of a GitHub App, delete the preceding step and pass
      # `token: ${{ secrets.DEPENDABOT_TRIAGE_TOKEN }}` to the Action.

      - uses: actions/checkout@v7
        with:
          persist-credentials: false

      - uses: pokutuna/dependabot-alert-triage@v0
        with:
          token: ${{ steps.app-token.outputs.token }}
          dry_run: ${{ inputs.dry_run }}
```

The Action reads the rule file from your repository, so the workflow needs the checkout step.

## Try it manually first

To confirm that the rules select the alerts you expect, follow these steps before you automate anything:

1. In the **Actions** tab, run the workflow with `dry_run` set to `true`.
2. In the job summary, review the candidate list.
3. If the list holds an alert you didn't expect, narrow the rules and repeat the dry run.
4. Run the workflow again with `dry_run` set to `false`. The Action dismisses the candidates and reports the result in the job summary.
5. In the repository's **Security** tab, check the dismissed alerts. You can reopen any alert manually.

## Run on a schedule

After the manual runs behave as you expect, add a `schedule` trigger and change the `dry_run` default to `false`:

```yaml
on:
  schedule:
    - cron: "0 3 * * 1"
  workflow_dispatch:
    inputs:
      dry_run:
        description: Only report matching alerts
        type: boolean
        default: false
```

Pass `dry_run: ${{ inputs.dry_run || false }}` to the Action, because `inputs` is empty on a scheduled run. To keep manual dry runs available, leave the `workflow_dispatch` trigger in place.

## Versions

`@v0` moves to each release, so a workflow that passes a write-capable token picks up code that you haven't reviewed. In that workflow, pin every step that handles the token — this Action, `actions/create-github-app-token`, and `actions/checkout` — to a full-length commit SHA or to an immutable version tag such as `v0.1.0`.

The releases are earlier than 1.0, so the inputs and the rule format can still change. The release notes name every change that breaks compatibility.

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `token` | Yes | — | Token that reads and updates Dependabot alerts |
| `dry_run` | No | `false` | Report the matching alerts without dismissing them |
| `config` | No | `.github/dependabot-triage.yml` | Path to the rule file |
| `max_alerts` | No | `1000` | Maximum number of open alerts to read from the API in one run. The Action doesn't examine an alert beyond this limit |

## Outputs

| Output | Description |
|---|---|
| `candidates_count` | Number of the alerts read in this run that matched a rule. When the run reaches `max_alerts`, this count excludes every alert that the Action didn't examine |
| `dismissed_count` | Number of the alerts that the Action dismissed |

## Safety behavior

- **`dry_run: true` updates nothing.** The Action reports the candidates to the job summary and then returns. A run dismisses every candidate that it finds, with no limit on the count, so run a rule change with `dry_run: true` before you apply it.
- **Malware alerts need an explicit opt-in.** A rule matches a malware alert only when it sets `classification: malware`.
- **The Action refuses to run on `pull_request` and `pull_request_target`.** Those events read the rule file from the pull request's own ref, which lets a pull request dismiss alerts by editing its rules. Every other event runs with a warning, so limit a workflow that passes a write-capable token to `schedule` and `workflow_dispatch`.

Only an `open` alert can be a candidate. The Action fetches and checks each candidate again immediately before it dismisses the alert, so it skips an alert that someone fixed or dismissed after the listing.

Repositories that turn on **Prevent direct alert dismissals** reject direct dismissals. This Action doesn't support the dismissal-request flow that those repositories require.
