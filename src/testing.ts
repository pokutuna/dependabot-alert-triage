import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DependabotAlert, type TriageRule, ruleSchema } from "./triage";

export function writeConfig(content: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "triage-")), "config.yml");
  writeFileSync(path, content);
  return path;
}

export function alert(overrides: Partial<DependabotAlert> = {}): DependabotAlert {
  return {
    number: 1,
    state: "open",
    dependency: {
      manifest_path: "sketch/foo/requirements.txt",
      package: { ecosystem: "pip", name: "torch" },
    },
    security_advisory: { classification: "general", severity: "high" },
    ...overrides,
  };
}

export function rule(overrides: Record<string, unknown> = {}): TriageRule {
  return ruleSchema.parse({
    reason: "tolerable_risk",
    comment: "accepted risk",
    ...overrides,
  });
}
