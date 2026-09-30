import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const helperRoot = path.dirname(fileURLToPath(import.meta.url));
const launcherPath = path.join(helperRoot, "run-live.sh");

type LauncherMode = "valid-failed" | "malformed" | "missing";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function writeFakeVitest(
  sourceRoot: string,
  receiptRoot: string,
  mode: LauncherMode,
): Promise<void> {
  const vitestRoot = path.join(sourceRoot, "node_modules", "vitest");
  await mkdir(vitestRoot, { recursive: true, mode: 0o700 });
  const fakeVitest = `
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const isLiveRun = process.argv.some((argument) => argument.endsWith("live-runner.test.ts"));
if (!isLiveRun) process.exit(0);

const runId = process.env.CHRONICLE_RUN_ID;
const scratchRoot = process.env.CHRONICLE_LIVE_SCRATCH;
if (!runId || !scratchRoot) process.exit(3);

const receiptRoot = ${JSON.stringify(receiptRoot)};
const runRoot = path.join(receiptRoot, "runs", runId);
await mkdir(runRoot, { recursive: true, mode: 0o700 });

if (${JSON.stringify(mode)} !== "missing") {
  const progress = {
    admittedRequests: 0,
    httpStatus: null,
    maxRequests: 18,
    schemaVersion: 1,
    status: "request-started",
  };
  await writeFile(
    path.join(scratchRoot, "fetch-progress.json"),
    JSON.stringify(progress),
    { encoding: "utf8", mode: 0o600 },
  );
}

if (${JSON.stringify(mode)} === "valid-failed") {
  const envelope = {
    schemaVersion: 1,
    kind: "chronicle-llm-judge-live-diagnostic",
    terminal: {
      status: "failed",
      code: "calibration-mismatch",
      stage: "calibration",
    },
    runId,
    dispatchCount: 0,
    dispatches: [],
  };
  await writeFile(
    path.join(runRoot, "diagnostic-envelope.json"),
    JSON.stringify(envelope),
    { encoding: "utf8", mode: 0o600 },
  );
} else if (${JSON.stringify(mode)} === "malformed") {
  await writeFile(
    path.join(runRoot, "diagnostic-envelope.json"),
    "{}",
    { encoding: "utf8", mode: 0o600 },
  );
}

process.exit(1);
`;
  await writeFile(path.join(vitestRoot, "vitest.mjs"), fakeVitest, {
    encoding: "utf8",
    mode: 0o600,
  });
}

async function runLauncher(mode: LauncherMode) {
  const root = await mkdtemp(path.join(os.tmpdir(), "chronicle-launcher-summary-"));
  await chmod(root, 0o700);
  const sourceRoot = path.join(root, "runtime");
  const receiptRoot = path.join(root, "receipts");
  const helperCopy = path.join(root, "helper");
  await Promise.all([
    mkdir(sourceRoot, { recursive: true, mode: 0o700 }),
    mkdir(receiptRoot, { recursive: true, mode: 0o700 }),
    mkdir(helperCopy, { recursive: true, mode: 0o700 }),
  ]);
  await writeFakeVitest(sourceRoot, receiptRoot, mode);

  const launcher = (await readFile(launcherPath, "utf8"))
    .replace(
      'source_root="/home/grimodex/Grimodex/.artifacts/chronicle-source-support-v2-worktree"',
      `source_root=${shellQuote(sourceRoot)}`,
    )
    .replace(
      'receipt_root="/home/grimodex/Grimodex/.artifacts/narrative-eval/chronicle-full-calibration-20260907"',
      `receipt_root=${shellQuote(receiptRoot)}`,
    );
  const launcherCopy = path.join(helperCopy, "run-live.sh");
  await writeFile(launcherCopy, launcher, { encoding: "utf8", mode: 0o700 });
  await chmod(launcherCopy, 0o700);

  try {
    const result = await new Promise<{
      code: number | null;
      output: string;
    }>((resolve, reject) => {
      const child = spawn(
        "/usr/bin/script",
        [
          "--quiet",
          "--flush",
          "--return",
          "--command",
          `/usr/bin/bash ${shellQuote(launcherCopy)}`,
          "/dev/null",
        ],
        {
          cwd: "/home/grimodex/Grimodex",
          env: {
            HOME: "/home/grimodex",
            LANG: "C.UTF-8",
            PATH: "/usr/bin:/bin",
            TERM: "xterm",
            TMPDIR: "/tmp",
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      const output: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => output.push(chunk));
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`launcher timed out for ${mode}`));
      }, 15_000);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        resolve({ code, output: Buffer.concat(output).toString("utf8") });
      });
      child.stdin.write("offline-test-key\n");
      child.stdin.end();
    });
    return result;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("run-live launcher summary", () => {
  it("prints a persisted calibration mismatch and exits one", async () => {
    const result = await runLauncher("valid-failed");

    expect(result.code).toBe(1);
    expect(result.output).toContain('"terminalCode":"calibration-mismatch"');
    expect(result.output).not.toContain('"terminalCode":"runtime-failure"');
  }, 30_000);

  it.each(["malformed", "missing"] as const)(
    "uses runtime-failure only for %s diagnostics",
    async (mode) => {
      const result = await runLauncher(mode);

      expect(result.code).toBe(1);
      expect(result.output).toContain('"terminalCode":"runtime-failure"');
    },
    30_000,
  );
});
