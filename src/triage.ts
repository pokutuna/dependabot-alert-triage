import { readFileSync } from "node:fs";
import picomatch from "picomatch";
import { parse } from "yaml";
import { z } from "zod";

export const ruleSchema = z.strictObject({
  match: z
    .strictObject({
      manifest_path: z.string().min(1).optional(),
      packages: z.record(z.string(), z.array(z.string().min(1)).min(1)).optional(),
    })
    .optional(),
  classification: z.enum(["general", "malware"]).default("general"),
  reason: z.enum(["fix_started", "inaccurate", "no_bandwidth", "not_used", "tolerable_risk"]),
  comment: z.string().min(1),
});

export const configSchema = z.strictObject({
  rules: z.array(ruleSchema).min(1),
});

export type TriageRule = z.infer<typeof ruleSchema>;
export type TriageConfig = z.infer<typeof configSchema>;

export const DEFAULT_CONFIG_PATH = ".github/dependabot-triage.yml";

function parseYaml(source: string, label: string): unknown {
  try {
    return parse(source);
  } catch (error) {
    throw new Error(
      `Invalid YAML in ${label}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function formatIssues(result: z.ZodError): string {
  return result.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

export function loadInlineRules(source: string): TriageConfig {
  const result = z.array(ruleSchema).min(1).safeParse(parseYaml(source, "rules input"));
  if (!result.success) {
    throw new Error(`Invalid rules input: ${formatIssues(result.error)}`);
  }
  return { rules: result.data };
}

export function loadConfig(path: string): TriageConfig {
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `Rule file not found: ${path}. Check the config input, and make sure the workflow ` +
          "checks out the repository before this step.",
      );
    }
    throw error;
  }

  const result = configSchema.safeParse(parseYaml(source, path));
  if (!result.success) {
    throw new Error(`Invalid config at ${path}: ${formatIssues(result.error)}`);
  }
  return result.data;
}

export interface DependabotAlert {
  number: number;
  state: string;
  dependency: {
    manifest_path?: string | null;
    package?: { ecosystem: string; name: string } | null;
  };
  security_advisory: {
    classification?: string | null;
    severity?: string | null;
    ghsa_id?: string | null;
  };
}

// Alerts report manifest_path relative to the repository root with no leading
// slash. Accept patterns written with a leading slash (the dependabot.yml
// `directory` convention) and treat a trailing slash as "everything under
// this directory".
export function normalizePathPattern(pattern: string): string {
  const stripped = pattern.replace(/^\/+/, "");
  if (stripped === "") return "**";
  if (stripped.endsWith("/")) return `${stripped}**`;
  return stripped;
}

// dot: true so patterns match dotfile segments; a rule matches whatever
// path or name the alert displays.
const GLOB_OPTIONS = { dot: true };

export function matchesRule(alert: DependabotAlert, rule: TriageRule): boolean {
  if (alert.state !== "open") return false;

  const classification = alert.security_advisory.classification ?? "general";
  if (classification !== rule.classification) return false;

  if (rule.match?.manifest_path) {
    const manifestPath = alert.dependency.manifest_path;
    const pattern = normalizePathPattern(rule.match.manifest_path);
    if (!manifestPath || !picomatch.isMatch(manifestPath, pattern, GLOB_OPTIONS)) return false;
  }

  if (rule.match?.packages) {
    const pkg = alert.dependency.package;
    if (!pkg) return false;
    const names = rule.match.packages[pkg.ecosystem];
    if (!names || !names.some((name) => picomatch.isMatch(pkg.name, name, GLOB_OPTIONS))) {
      return false;
    }
  }

  return true;
}

export interface Candidate {
  alert: DependabotAlert;
  rule: TriageRule;
}

// Rules are ordered: the first one that matches decides the reason and comment.
export function findCandidates(alerts: DependabotAlert[], rules: TriageRule[]): Candidate[] {
  const candidates: Candidate[] = [];
  for (const alert of alerts) {
    const rule = rules.find((rule) => matchesRule(alert, rule));
    if (rule) {
      candidates.push({ alert, rule });
    }
  }
  return candidates;
}
