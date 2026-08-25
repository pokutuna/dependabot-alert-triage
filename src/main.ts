import * as core from "@actions/core";
import * as github from "@actions/github";
import {
  type Candidate,
  type DependabotAlert,
  findCandidates,
  loadConfig,
  matchesRule,
} from "./triage";

function positiveIntInput(name: string): number {
  const raw = core.getInput(name);
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer, got: ${raw}`);
  }
  return value;
}

// Pull request events run whatever rule file the head ref carries, so a rule
// that has not been reviewed yet could select unrelated alerts. Nothing needs
// dismissing at pull request time, so refuse instead of trusting the ref.
const REFUSED_EVENTS = ["pull_request", "pull_request_target"];

export async function run(): Promise<void> {
  const eventName = github.context.eventName;
  if (REFUSED_EVENTS.includes(eventName)) {
    throw new Error(
      `Refusing to run on ${eventName}, which would read the rule file from an unreviewed ref. ` +
        "Trigger this action on schedule or workflow_dispatch instead.",
    );
  }
  if (eventName !== "schedule" && eventName !== "workflow_dispatch") {
    core.warning(
      `Running on ${eventName}. This action dismisses alerts based on the rule file in the ` +
        "checked-out ref; prefer schedule or workflow_dispatch so only reviewed rules apply.",
    );
  }

  const token = core.getInput("token", { required: true });
  const dryRun = core.getBooleanInput("dry_run");
  const configPath = core.getInput("config");
  const maxDismissals = positiveIntInput("max_dismissals");
  const maxAlerts = positiveIntInput("max_alerts");

  const config = loadConfig(configPath);
  const octokit = github.getOctokit(token);
  const { owner, repo } = github.context.repo;

  // Stop paginating at max_alerts so a repository with a large backlog cannot
  // exhaust the API budget or the runner's memory.
  const alerts: DependabotAlert[] = [];
  let reachedLimit = false;
  for await (const { data: page } of octokit.paginate.iterator(
    octokit.rest.dependabot.listAlertsForRepo,
    { owner, repo, state: "open", per_page: 100 },
  )) {
    alerts.push(...(page as unknown as DependabotAlert[]));
    if (alerts.length >= maxAlerts) {
      alerts.length = maxAlerts;
      reachedLimit = true;
      break;
    }
  }
  if (reachedLimit) {
    core.warning(
      `Read only the first ${maxAlerts} open alerts (max_alerts). Any alert beyond that ` +
        "limit was not examined in this run; raise max_alerts to cover them.",
    );
  }

  const candidates = findCandidates(alerts, config.rules);
  core.info(`Found ${candidates.length} candidates among ${alerts.length} open alerts`);
  core.setOutput("candidates_count", candidates.length);

  await writeSummary(candidates, dryRun);

  if (dryRun) {
    core.info("dry_run is true; no alerts were updated");
    core.setOutput("dismissed_count", 0);
    return;
  }

  if (candidates.length > maxDismissals) {
    core.setOutput("dismissed_count", 0);
    core.setFailed(
      `${candidates.length} candidates exceed max_dismissals (${maxDismissals}); no alerts were updated. ` +
        "Review the rules or raise max_dismissals.",
    );
    return;
  }

  let dismissed = 0;
  let skipped = 0;
  for (const { alert, rule } of candidates) {
    // Re-fetch and re-verify right before dismissing, so a stale listing never causes a wrong PATCH.
    const { data: fresh } = await octokit.rest.dependabot.getAlert({
      owner,
      repo,
      alert_number: alert.number,
    });
    if (!matchesRule(fresh as unknown as DependabotAlert, rule)) {
      core.info(`Skipped alert #${alert.number}: it no longer matches the rule`);
      skipped += 1;
      continue;
    }
    await octokit.rest.dependabot.updateAlert({
      owner,
      repo,
      alert_number: alert.number,
      state: "dismissed",
      dismissed_reason: rule.reason,
      dismissed_comment: rule.comment,
    });
    core.info(`Dismissed alert #${alert.number} (${rule.reason})`);
    dismissed += 1;
  }

  core.info(`Dismissed ${dismissed} alerts, skipped ${skipped}`);
  core.setOutput("dismissed_count", dismissed);
}

async function writeSummary(candidates: Candidate[], dryRun: boolean): Promise<void> {
  core.summary.addHeading(`Dependabot alert triage ${dryRun ? "(dry run)" : ""}`.trim(), 2);
  if (candidates.length === 0) {
    core.summary.addRaw("No open alerts matched the rules.", true);
  } else {
    core.summary.addTable([
      [
        { data: "Alert", header: true },
        { data: "Manifest", header: true },
        { data: "Package", header: true },
        { data: "Classification", header: true },
        { data: "Severity", header: true },
        { data: "Reason", header: true },
      ],
      ...candidates.map(({ alert, rule }) => [
        `#${alert.number}`,
        alert.dependency.manifest_path ?? "",
        alert.dependency.package
          ? `${alert.dependency.package.ecosystem}/${alert.dependency.package.name}`
          : "",
        alert.security_advisory.classification ?? "general",
        alert.security_advisory.severity ?? "",
        rule.reason,
      ]),
    ]);
  }
  await core.summary.write();
}
