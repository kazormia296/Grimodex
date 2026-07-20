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

function allRunCommands(job) {
  return job.steps
    .filter((step) => typeof step.run === "string")
    .map((step) => step.run)
    .join("\n");
}

function assertMeasuredBrowserJob(job, suite) {
  assert.equal(job["timeout-minutes"], 15);
  const commands = allRunCommands(job);
  assert.match(commands, /pnpm build:workspace:dependencies/);
  assert.match(commands, /playwright install/);
  assert.match(
    commands,
    new RegExp(
      `pnpm benchmark:browser-ci -- --suite ${suite} --runs 1 --output \\.artifacts/browser-ci/${suite}\\.json`,
    ),
  );

  const upload = job.steps.find(
    (step) =>
      typeof step.uses === "string" &&
      step.uses.startsWith("actions/upload-artifact@"),
  );
  assert.ok(upload, `${suite} must upload performance evidence`);
  assert.equal(upload.if, "always()");
  assert.equal(upload.with.path, `.artifacts/browser-ci/${suite}.json`);
  assert.equal(upload.with["if-no-files-found"], "error");
}

test("package.json exposes the browser CI benchmark entrypoint", async () => {
  const packageJson = JSON.parse(await read("package.json"));

  assert.equal(
    packageJson.scripts["benchmark:browser-ci"],
    "node scripts/browser-ci-benchmark.mjs",
  );
});

test("CI runs Browser and Storybook as independent measured jobs", async () => {
  const workflow = yaml.load(await read(".github/workflows/ci.yml"));
  const browser = workflow.jobs.browser;
  const storybook = workflow.jobs.storybook;

  assert.ok(browser, "browser job is required");
  assert.ok(storybook, "storybook job is required");
  assert.equal(browser.name, "Browser (Vitest browser)");
  assert.equal(storybook.name, "Storybook (Vitest browser)");

  assertMeasuredBrowserJob(browser, "browser");
  assertMeasuredBrowserJob(storybook, "storybook");

  assert.doesNotMatch(allRunCommands(browser), /--suite storybook/);
  assert.doesNotMatch(allRunCommands(storybook), /--suite browser(?:\s|$)/);
});
