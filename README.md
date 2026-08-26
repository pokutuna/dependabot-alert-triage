# dependabot-alert-triage

A rules-as-code GitHub Action that dismisses matching Dependabot alerts.

GitHub already provides [custom auto-triage rules](https://docs.github.com/en/code-security/concepts/supply-chain-security/dependabot-auto-triage-rules) for public repositories and organization-owned repositories with GitHub Code Security. Prefer them when available.

Use this Action when built-in rules aren't available or when you want rules, dismissal reasons, and comments in version control. Dismissal doesn't exclude a dependency from later scans.

## Use the Action

Before you add the workflow, [prepare a read/write token](#token-requirements) for Dependabot alerts. Then create `.github/workflows/dependabot-triage.yml`:

```yaml
name: Dependabot triage

on:
  schedule:
    - cron: "0 3 * * 1"
  workflow_dispatch:
    inputs:
      dry_run:
        description: Only report matching alerts
        type: boolean
        default: true

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

      - uses: pokutuna/dependabot-alert-triage@v0
        with:
          token: ${{ steps.app-token.outputs.token }}
          dry_run: ${{ inputs.dry_run || false }}
          rules: |
            - match:
                manifest_path: "sketch/**"
              reason: not_used
              comment: sketch/ contains experiments that are never deployed
```

The example creates a short-lived GitHub App token with read and write access. It keeps the rule next to the Action and doesn't require `actions/checkout`.

Manual runs default to dry-run mode, and scheduled runs apply the rules. Run the workflow manually, review the candidates in the job summary, and narrow any unexpected matches before the first scheduled run.

## Rules

Conditions within a rule combine with AND, and separate rules combine with OR. An omitted condition matches any value. Rules are evaluated in order, and the first match decides the dismissal reason and comment.

Each rule supports the following fields:

| Field | Example | Description |
| --- | --- | --- |
| `match.manifest_path` | `"sketch/**"` | Glob for the manifest that reported the alert |
| `match.packages.<ecosystem>` | `["@react-router/*"]` | Package-name globs grouped by the exact [`dependency.package.ecosystem`](https://docs.github.com/en/rest/dependabot/alerts?apiVersion=2022-11-28#list-dependabot-alerts-for-a-repository) value |
| `classification` | `malware` | `general`, the default, or `malware` |
| `reason` | `not_used` | Required. `fix_started`, `inaccurate`, `no_bandwidth`, `not_used`, or `tolerable_risk` |
| `comment` | `"Never deployed."` | Required. Text that GitHub records with the dismissal |

A rule with no match conditions selects every open `general` alert, so use one only as a deliberate catch-all and place it last.

A package rule also matches advisories published later. Scope it with `manifest_path` when possible, and record the accepted-risk rationale in `comment`. Invalid or unknown fields fail the run.

### Glob patterns

`manifest_path` and package names accept full-value, case-sensitive glob patterns:

| Pattern | Matches | Doesn't match |
| --- | --- | --- |
| `sketch/**` | `sketch/requirements.txt`, `sketch/tools/pnpm-lock.yaml` | `apps/sketch.lock` |
| `sketch/*` | `sketch/requirements.txt` | `sketch/tools/pnpm-lock.yaml` |
| `"@react-router/*"` | Every package in that npm scope | `react-router` |

Quote a pattern that starts with `@` or `*` so that YAML doesn't misparse it.

### Use a rule file

For a larger rule set, store the rules in `.github/dependabot-triage.yml`:

```yaml
rules:
  - match:
      manifest_path: "sketch/**"
      packages:
        pip:
          - torch
    reason: tolerable_risk
    comment: torch is pinned for compatibility in this experimental environment
```

Check out the repository before the Action, and set `config`:

```yaml
- uses: actions/checkout@v7
  with:
    persist-credentials: false

- uses: pokutuna/dependabot-alert-triage@v0
  with:
    token: ${{ steps.app-token.outputs.token }}
    dry_run: ${{ inputs.dry_run || false }}
    config: .github/dependabot-triage.yml
```

The default path is `.github/dependabot-triage.yml`. Set `config` to use another path. Don't specify `config` and `rules` together.

## Token requirements

The Action requires a token with read and write access to Dependabot alerts:

- A GitHub App installation token is recommended because it isn't tied to an individual account and expires after each run. [Register an App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app) with the **Dependabot alerts** repository permission set to **Read and write**, [install it](https://docs.github.com/en/apps/using-github-apps/installing-your-own-github-app) on the target repository, and store its client ID as a repository variable and its private key as a repository secret.
- A fine-grained personal access token also works. [Create a token](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-fine-grained-personal-access-token) with read and write access to **Dependabot alerts** on the target repository, and store it as a repository secret.

The workflow `GITHUB_TOKEN` supports only read access to Dependabot alerts. Use it only for a workflow that is permanently limited to `dry_run: true`.

## Safety behavior

- `dry_run: true` reports candidates without updating alerts.
- Malware alerts require a rule with `classification: malware`.
- The Action refuses to run on `pull_request` and `pull_request_target`. Other event types produce a warning, so use `schedule` and `workflow_dispatch` with a write-capable token.
- The Action rechecks each candidate immediately before dismissal and skips alerts that are no longer open or no longer match.

Repositories with **Prevent direct alert dismissals** enabled reject direct dismissals. This Action doesn't support their dismissal-request flow.

## Reference

### Inputs

The Action accepts the following inputs:

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `token` | Yes | — | Token that reads and updates Dependabot alerts |
| `dry_run` | No | `false` | Report matching alerts without dismissing them |
| `rules` | No | — | Rules supplied as an inline YAML array. Cannot be combined with `config` |
| `config` | No | `.github/dependabot-triage.yml` | Path to the rule file. Cannot be combined with `rules` |
| `max_alerts` | No | `1000` | Maximum number of open alerts to read. Alerts beyond this limit aren't examined |

### Outputs

The Action produces the following outputs:

| Output | Description |
| --- | --- |
| `candidates_count` | Number of examined alerts that matched a rule |
| `dismissed_count` | Number of alerts that the Action dismissed |

## Versions

The examples use the moving `@v0` tag for readability. In a workflow with a write-capable token, pin every `uses:` step to a full-length commit SHA or immutable version tag.

Releases before 1.0 can change the inputs and rule format. The release notes identify breaking changes.
