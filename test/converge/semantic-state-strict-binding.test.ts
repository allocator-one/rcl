import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  convergeRunStatePath,
  processRoundReport,
} from "../../src/converge/run-state.js";

const directories: string[] = [];
const target = "strict-bound-report-target";
const runId = "00000000-0000-7000-8000-000000000001";

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function reportJson(
  kind: "valid" | "duplicate_key" | "rounded_number",
): string {
  if (kind === "duplicate_key") {
    return `{"run":{"id":"00000000-0000-7000-8000-000000000099","id":"${runId}","converge":{"target":"${target}","round":1}},"findings":[]}`;
  }

  if (kind === "rounded_number") {
    return `{"run":{"id":"${runId}","converge":{"target":"${target}","round":1.0000000000000001}},"findings":[]}`;
  }

  return JSON.stringify({
    run: { id: runId, converge: { target, round: 1 } },
    findings: [],
  });
}

it("accepts a strictly decoded bound report and records its exact bytes", async () => {
  const directory = await mkdtemp(`${tmpdir()}/strict-bound-report-`);
  directories.push(directory);
  const raw = reportJson("valid");

  await expect(
    processRoundReport({
      gitCommonDir: directory,
      target,
      round: 1,
      runId,
      findings: [],
      evidence: { reportJson: raw },
    }),
  ).resolves.toMatchObject({ findings: [] });

  await expect(
    readFile(convergeRunStatePath(directory, target), "utf8"),
  ).resolves.toContain('"target": "strict-bound-report-target"');
});

it.each(["duplicate_key", "rounded_number"] as const)(
  "refuses a %s bound report before writing state",
  async (kind) => {
    const directory = await mkdtemp(`${tmpdir()}/strict-bound-report-`);
    directories.push(directory);

    await expect(
      processRoundReport({
        gitCommonDir: directory,
        target,
        round: 1,
        runId,
        findings: [],
        evidence: { reportJson: reportJson(kind) },
      }),
    ).rejects.toThrow("Invalid immutable report JSON.");

    await expect(
      readFile(convergeRunStatePath(directory, target), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  },
);
