import * as core from "@actions/core";
import * as github from "@actions/github";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "./main";
import { alert, writeConfig } from "./testing";
import type { DependabotAlert } from "./triage";

vi.mock("@actions/core");
vi.mock("@actions/github");

const REPO = { owner: "o", repo: "r" };

const RULE_FILE = `
rules:
  - match:
      manifest_path: "sketch/**"
    reason: tolerable_risk
    comment: not used in production
`;

const testAlert = (number: number, overrides: Partial<DependabotAlert> = {}) =>
  alert({
    number,
    dependency: { manifest_path: "sketch/package-lock.json" },
    ...overrides,
  });

interface Options {
  alerts?: DependabotAlert[];
  inputs?: Record<string, string>;
  booleanInputs?: Record<string, boolean>;
  eventName?: string;
  // Alert state as seen by the re-verification fetch, keyed by alert number.
  freshAlerts?: Record<number, DependabotAlert>;
}

function setup(options: Options = {}) {
  const alerts = options.alerts ?? [testAlert(1)];
  const inputs: Record<string, string> = {
    token: "t",
    config: writeConfig(RULE_FILE),
    max_alerts: "1000",
    ...options.inputs,
  };

  vi.mocked(core.getInput).mockImplementation((name: string) => inputs[name] ?? "");
  vi.mocked(core.getBooleanInput).mockImplementation(
    (name: string) => options.booleanInputs?.[name] ?? false,
  );
  vi.mocked(core.summary).addHeading = vi.fn().mockReturnThis();
  vi.mocked(core.summary).addRaw = vi.fn().mockReturnThis();
  vi.mocked(core.summary).addTable = vi.fn().mockReturnThis();
  vi.mocked(core.summary).write = vi.fn().mockResolvedValue(core.summary);

  const updateAlert = vi.fn().mockResolvedValue({});
  const getAlert = vi.fn(async ({ alert_number }: { alert_number: number }) => ({
    data: options.freshAlerts?.[alert_number] ?? alerts.find((a) => a.number === alert_number),
  }));

  // paginate.iterator yields pages of 100, mirroring the per_page the action requests.
  const iterator = async function* () {
    for (let i = 0; i < alerts.length; i += 100) {
      yield { data: alerts.slice(i, i + 100) };
    }
  };

  vi.mocked(github.getOctokit).mockReturnValue({
    paginate: { iterator },
    rest: { dependabot: { getAlert, updateAlert } },
  } as unknown as ReturnType<typeof github.getOctokit>);

  vi.mocked(github, { partial: true }).context = {
    eventName: options.eventName ?? "workflow_dispatch",
    repo: REPO,
  } as typeof github.context;

  return { updateAlert, getAlert };
}

function outputs(): Record<string, unknown> {
  return Object.fromEntries(vi.mocked(core.setOutput).mock.calls);
}

describe("run", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("dismisses a matching alert with the rule's reason and comment", async () => {
    const { updateAlert } = setup();
    await run();

    expect(updateAlert).toHaveBeenCalledTimes(1);
    expect(updateAlert).toHaveBeenCalledWith({
      owner: "o",
      repo: "r",
      alert_number: 1,
      state: "dismissed",
      dismissed_reason: "tolerable_risk",
      dismissed_comment: "not used in production",
    });
    expect(outputs()).toMatchObject({
      candidates_count: 1,
      dismissed_count: 1,
    });
  });

  it("never updates an alert during a dry run", async () => {
    const { updateAlert, getAlert } = setup({
      booleanInputs: { dry_run: true },
    });
    await run();

    expect(updateAlert).not.toHaveBeenCalled();
    // A dry run returns before the dismissal loop, so it does not even re-fetch.
    expect(getAlert).not.toHaveBeenCalled();
    expect(outputs()).toMatchObject({
      candidates_count: 1,
      dismissed_count: 0,
    });
  });

  it("skips an alert that no longer matches when re-verified", async () => {
    const { updateAlert } = setup({
      alerts: [testAlert(1), testAlert(2)],
      freshAlerts: { 1: testAlert(1, { state: "fixed" }) },
    });
    await run();

    expect(updateAlert).toHaveBeenCalledTimes(1);
    expect(updateAlert).toHaveBeenCalledWith(expect.objectContaining({ alert_number: 2 }));
    expect(outputs()).toMatchObject({ dismissed_count: 1 });
  });

  it("stops reading alerts at max_alerts", async () => {
    const alerts = Array.from({ length: 250 }, (_, i) => testAlert(i + 1));
    const { updateAlert } = setup({
      alerts,
      inputs: { max_alerts: "100" },
    });
    await run();

    expect(updateAlert).toHaveBeenCalledTimes(100);
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining("max_alerts"));
    expect(outputs()).toMatchObject({ candidates_count: 100 });
  });

  it("refuses to run on pull request events", async () => {
    const { updateAlert } = setup({ eventName: "pull_request_target" });
    await expect(run()).rejects.toThrow(/Refusing to run on pull_request_target/);
    expect(updateAlert).not.toHaveBeenCalled();
  });

  it("warns when the event is neither schedule nor workflow_dispatch", async () => {
    setup({ eventName: "push" });
    await run();
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining("Running on push"));
  });

  it("rejects a max_alerts value that overflows to a non-safe integer", async () => {
    setup({ inputs: { max_alerts: "99999999999999999999" } });
    await expect(run()).rejects.toThrow(/max_alerts must be a positive integer/);
  });

  it("leaves malware alerts alone when no rule opts in", async () => {
    const { updateAlert } = setup({
      alerts: [
        testAlert(1, {
          security_advisory: { classification: "malware", severity: "high" },
        }),
      ],
    });
    await run();

    expect(updateAlert).not.toHaveBeenCalled();
    expect(outputs()).toMatchObject({ candidates_count: 0 });
  });
});
