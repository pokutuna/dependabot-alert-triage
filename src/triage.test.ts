import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { alert, rule, writeConfig } from "./testing";
import { findCandidates, loadConfig, loadInlineRules, matchesRule } from "./triage";

describe("loadConfig", () => {
  it("parses a valid config", () => {
    const config = loadConfig(
      writeConfig(`
rules:
  - match:
      manifest_path: "sketch/**"
      packages:
        pip:
          - torch
    classification: general
    reason: tolerable_risk
    comment: torch cannot be updated in the experiment environment
`),
    );
    expect(config.rules).toHaveLength(1);
    expect(config.rules[0].match?.packages).toEqual({ pip: ["torch"] });
  });

  it("rejects a rule without reason", () => {
    expect(() => loadConfig(writeConfig("rules:\n  - comment: x\n"))).toThrow(/reason/);
  });

  it("rejects a rule without comment", () => {
    expect(() => loadConfig(writeConfig("rules:\n  - reason: not_used\n"))).toThrow(/comment/);
  });

  it("rejects an unknown reason", () => {
    expect(() => loadConfig(writeConfig("rules:\n  - reason: wontfix\n    comment: x\n"))).toThrow(
      /Invalid config/,
    );
  });

  it("defaults classification to general", () => {
    const config = loadConfig(writeConfig("rules:\n  - reason: not_used\n    comment: x\n"));
    expect(config.rules[0].classification).toBe("general");
  });

  it("reports a missing rule file with a hint about checkout", () => {
    expect(() => loadConfig(join(tmpdir(), "triage-missing", "config.yml"))).toThrow(
      /Rule file not found.*checks out the repository/s,
    );
  });

  it("reports invalid YAML with the file path", () => {
    expect(() => loadConfig(writeConfig("rules:\n  - reason: [\n"))).toThrow(/Invalid YAML in/);
  });

  it("rejects unknown keys", () => {
    expect(() =>
      loadConfig(writeConfig("rules:\n  - reason: not_used\n    comment: x\n    severity: high\n")),
    ).toThrow(/Invalid config/);
  });
});

describe("loadInlineRules", () => {
  it("parses a YAML rule array", () => {
    const config = loadInlineRules(`
- match:
    manifest_path: "sketch/**"
  reason: not_used
  comment: experiments are never deployed
`);

    expect(config.rules).toHaveLength(1);
    expect(config.rules[0].match?.manifest_path).toBe("sketch/**");
  });

  it("rejects a config object instead of a rule array", () => {
    expect(() =>
      loadInlineRules(
        "rules:\n  - reason: not_used\n    comment: experiments are never deployed\n",
      ),
    ).toThrow(/Invalid rules input/);
  });

  it("reports invalid YAML as coming from the rules input", () => {
    expect(() => loadInlineRules("- reason: [\n")).toThrow(/Invalid YAML in rules input/);
  });
});

describe("matchesRule", () => {
  it("matches only open alerts", () => {
    expect(matchesRule(alert(), rule())).toBe(true);
    expect(matchesRule(alert({ state: "dismissed" }), rule())).toBe(false);
  });

  it("excludes malware alerts from a general rule", () => {
    const malware = alert({ security_advisory: { classification: "malware" } });
    expect(matchesRule(malware, rule())).toBe(false);
  });

  it("matches malware alerts only with an explicit malware rule", () => {
    const malware = alert({ security_advisory: { classification: "malware" } });
    expect(matchesRule(malware, rule({ classification: "malware" }))).toBe(true);
    expect(matchesRule(alert(), rule({ classification: "malware" }))).toBe(false);
  });

  it("matches manifest_path with a glob", () => {
    const r = rule({ match: { manifest_path: "sketch/**" } });
    expect(matchesRule(alert(), r)).toBe(true);
    expect(
      matchesRule(alert({ dependency: { manifest_path: "apps/web/package-lock.json" } }), r),
    ).toBe(false);
  });

  it("does not cross directories with a single star", () => {
    const r = rule({ match: { manifest_path: "sketch/*" } });
    expect(matchesRule(alert({ dependency: { manifest_path: "sketch/setup.py" } }), r)).toBe(true);
    expect(matchesRule(alert(), r)).toBe(false);
  });

  it("ignores a leading slash in manifest_path", () => {
    const r = rule({ match: { manifest_path: "/sketch/**" } });
    expect(matchesRule(alert(), r)).toBe(true);
  });

  it("treats a trailing slash as everything under the directory", () => {
    const r = rule({ match: { manifest_path: "sketch/" } });
    expect(matchesRule(alert(), r)).toBe(true);
  });

  it("matches dotfile path segments", () => {
    const r = rule({ match: { manifest_path: "sketch/**" } });
    expect(
      matchesRule(
        alert({
          dependency: { manifest_path: "sketch/.tools/package.json" },
        }),
        r,
      ),
    ).toBe(true);
  });

  it("matches packages by exact ecosystem and name", () => {
    const r = rule({ match: { packages: { pip: ["torch"] } } });
    expect(matchesRule(alert(), r)).toBe(true);
    expect(
      matchesRule(
        alert({
          dependency: { package: { ecosystem: "pip", name: "torchvision" } },
        }),
        r,
      ),
    ).toBe(false);
  });

  it("matches package names with a glob", () => {
    const r = rule({ match: { packages: { npm: ["@react-router/*"] } } });
    const npmAlert = (name: string) =>
      alert({ dependency: { package: { ecosystem: "npm", name } } });
    expect(matchesRule(npmAlert("@react-router/dev"), r)).toBe(true);
    expect(matchesRule(npmAlert("@react-router/node"), r)).toBe(true);
    expect(matchesRule(npmAlert("react-router"), r)).toBe(false);
  });

  it("does not match a package in another ecosystem", () => {
    const r = rule({ match: { packages: { npm: ["torch"] } } });
    expect(matchesRule(alert(), r)).toBe(false);
  });

  it("matches any general alert when the rule has no conditions", () => {
    expect(matchesRule(alert(), rule())).toBe(true);
    expect(matchesRule(alert({ dependency: {} }), rule())).toBe(true);
  });
});

describe("findCandidates", () => {
  it("uses the first matching rule", () => {
    const rules = [
      rule({
        match: { manifest_path: "sketch/**" },
        reason: "tolerable_risk",
      }),
      rule({ reason: "not_used" }),
    ];
    const candidates = findCandidates(
      [
        alert(),
        alert({
          number: 2,
          dependency: { manifest_path: "package-lock.json" },
        }),
      ],
      rules,
    );
    expect(candidates).toHaveLength(2);
    // The first alert matches both rules, so picking rules[0] shows the search
    // stops at the first match rather than falling through to the catch-all.
    expect(candidates[0].rule).toBe(rules[0]);
    expect(candidates[1].rule).toBe(rules[1]);
  });
});
