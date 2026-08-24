import { readFileSync } from "node:fs";
import picomatch from "picomatch";
import { parse } from "yaml";
import { z } from "zod";

export const ruleSchema = z
  .object({
    match: z
      .object({
        manifest_path: z.string().min(1).optional(),
        packages: z.record(z.string(), z.array(z.string().min(1)).min(1)).optional(),
      })
      .strict()
      .optional(),
    classification: z.enum(["general", "malware"]).default("general"),
    reason: z.enum(["fix_started", "inaccurate", "no_bandwidth", "not_used", "tolerable_risk"]),
    comment: z.string().min(1),
  })
  .strict();

export const configSchema = z
  .object({
    rules: z.array(ruleSchema).min(1),
  })
  .strict();

export type TriageRule = z.infer<typeof ruleSchema>;
export type TriageConfig = z.infer<typeof configSchema>;

export function loadConfig(path: string): TriageConfig {
  const parsed = parse(readFileSync(path, "utf8"));
  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid config at ${path}: ${details}`);
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

export function matchesRule(alert: DependabotAlert, rule: TriageRule): boolean {
  if (alert.state !== "open") return false;

  const classification = alert.security_advisory.classification ?? "general";
  if (classification !== rule.classification) return false;

  if (rule.match?.manifest_path) {
    const manifestPath = alert.dependency.manifest_path;
    if (!manifestPath || !picomatch.isMatch(manifestPath, rule.match.manifest_path)) return false;
  }

  if (rule.match?.packages) {
    const pkg = alert.dependency.package;
    if (!pkg) return false;
    const names = rule.match.packages[pkg.ecosystem];
    if (!names || !names.includes(pkg.name)) return false;
  }

  return true;
}

export interface Candidate {
  alert: DependabotAlert;
  rule: TriageRule;
  ruleIndex: number;
}

export function findCandidates(alerts: DependabotAlert[], rules: TriageRule[]): Candidate[] {
  const candidates: Candidate[] = [];
  for (const alert of alerts) {
    const ruleIndex = rules.findIndex((rule) => matchesRule(alert, rule));
    if (ruleIndex >= 0) {
      candidates.push({ alert, rule: rules[ruleIndex], ruleIndex });
    }
  }
  return candidates;
}
