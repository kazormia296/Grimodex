import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import yaml from "js-yaml";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

async function read(relativePath) {
  return readFile(path.join(repoRoot, relativePath), "utf8");
}

function runCommands(job) {
  return job.steps
    .filter((step) => typeof step.run === "string")
    .map((step) => step.run)
    .join("\n");
}

test("package.json exposes the isolated Electron product journey runner", async () => {
  const packageJson = JSON.parse(await read("package.json"));
  assert.equal(
    packageJson.scripts["electron:product-journeys"],
    "node electron/scripts/product-journeys.mjs",
  );
});

test("CI has a dedicated product-journeys gate with native Electron and SQLite", async () => {
  const workflow = yaml.load(await read(".github/workflows/ci.yml"));
  const job = workflow.jobs["electron-product-journeys"];

  assert.ok(job, "electron-product-journeys job is required");
  assert.equal(job["runs-on"], "ubuntu-24.04");
  const commands = runCommands(job);
  assert.match(commands, /pnpm exec playwright install-deps chromium/);
  assert.match(commands, /pnpm napi:build/);
  assert.match(commands, /pnpm electron:build/);
  assert.match(
    commands,
    /xvfb-run --auto-servernum --server-args="-screen 0 1920x1080x24" pnpm electron:product-journeys/,
  );

  const upload = job.steps.find(
    (step) =>
      typeof step.uses === "string" &&
      step.uses.startsWith("actions/upload-artifact@"),
  );
  assert.ok(upload, "product journey failures must upload artifacts");
  assert.equal(upload.if, "always()");
  assert.equal(upload.with.path, ".artifacts/product-journeys");
  assert.equal(upload.with["retention-days"], 14);
});

test("product runner keeps at least two real boundary journeys", async () => {
  const source = await read("electron/scripts/product-journeys.mjs");
  assert.match(source, /editor-persistence/);
  assert.match(source, /workspace-switch-authority/);
  assert.match(source, /open_workspace/);
  assert.match(source, /db_execute/);
  assert.match(source, /workspace-menu-trigger/);
});

test("performance smoke reuses the product journey boundary helpers", async () => {
  const source = await read("electron/scripts/smoke.mjs");

  assert.match(
    source,
    /import \{ invokeOk, waitUntil \} from "\.\/product-journey-harness\.mjs";/,
  );
  assert.doesNotMatch(source, /async function invokeOk\(/);
  assert.doesNotMatch(source, /async function waitUntil\(/);
});
