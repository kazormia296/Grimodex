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

function assertMeasuredBrowserJob(job, suite, benchmarkFlags = "") {
  assert.equal(job["timeout-minutes"], 15);
  const commands = allRunCommands(job);
  const dependencyInstall = job.steps.find(
    (step) => step.run === "pnpm install --frozen-lockfile",
  );
  assert.ok(dependencyInstall, `${suite} must use the frozen lockfile`);
  assert.match(commands, /pnpm build:workspace:dependencies/);

  const coldCacheInstall = job.steps.find(
    (step) => step.run === "pnpm exec playwright install --with-deps chromium",
  );
  assert.ok(coldCacheInstall, `${suite} must install Chromium on a cold cache`);
  assert.equal(
    coldCacheInstall.if,
    "steps.pw-cache.outputs.cache-hit != 'true'",
  );

  const cacheHitInstall = job.steps.find(
    (step) => step.run === "pnpm exec playwright install-deps chromium",
  );
  assert.ok(
    cacheHitInstall,
    `${suite} must install Chromium system dependencies on a cache hit`,
  );
  assert.equal(
    cacheHitInstall.if,
    "steps.pw-cache.outputs.cache-hit == 'true'",
  );

  const benchmarkStep = job.steps.find((step) =>
    step.run?.startsWith("pnpm benchmark:browser-ci -- "),
  );
  assert.ok(benchmarkStep, `${suite} must run through the benchmark wrapper`);
  assert.equal(
    benchmarkStep.run,
    `pnpm benchmark:browser-ci -- --suite ${suite} --runs 1${benchmarkFlags} --output .artifacts/browser-ci/${suite}.json`,
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
  assert.equal(upload.with["retention-days"], 14);
}

test("package.json exposes the browser CI benchmark entrypoint", async () => {
  const packageJson = JSON.parse(await read("package.json"));

  assert.equal(
    packageJson.scripts["benchmark:browser-ci"],
    "node scripts/browser-ci-benchmark.mjs",
  );
  assert.equal(
    packageJson.scripts["test:webgl"],
    "vitest --config vitest.webgl.config.ts",
  );
});

test("browser configs isolate deterministic WebGL from the normal suite", async () => {
  const browserConfig = await read("vitest.browser.config.ts");
  const webglConfig = await read("vitest.webgl.config.ts");

  assert.match(browserConfig, /provider:\s*playwright\(\)/);
  assert.match(
    browserConfig,
    /exclude:\s*\[[\s\S]*?"src\/features\/editor\/zen\/ZenMultipassCanvas\.browser\.test\.tsx",?[\s\S]*?"src\/features\/editor\/zen\/ZenBlurResearchRunner\.browser\.test\.tsx",?[\s\S]*?\]/,
  );
  assert.doesNotMatch(browserConfig, /swiftshader/i);
  assert.doesNotMatch(browserConfig, /connectTimeout/);
  assert.doesNotMatch(browserConfig, /api:\s*\{/);

  assert.match(
    webglConfig,
    /include:\s*\[\s*"src\/features\/editor\/zen\/ZenMultipassCanvas\.browser\.test\.tsx",?\s*\]/,
  );
  assert.match(webglConfig, /--enable-unsafe-swiftshader/);
  assert.match(webglConfig, /--use-angle=swiftshader/);
  assert.match(
    webglConfig,
    /api:\s*\{\s*host:\s*"127\.0\.0\.1",\s*port:\s*45123\s*\}/,
  );
  assert.match(webglConfig, /connectTimeout:\s*180_000/);
  assert.match(webglConfig, /fileParallelism:\s*false/);
  assert.match(webglConfig, /maxWorkers:\s*1/);
});

test("CI runs Browser, WebGL, and Storybook as independent jobs", async () => {
  const workflow = yaml.load(await read(".github/workflows/ci.yml"));
  const browser = workflow.jobs.browser;
  const webgl = workflow.jobs.webgl;
  const storybook = workflow.jobs.storybook;

  assert.ok(browser, "browser job is required");
  assert.ok(webgl, "webgl job is required");
  assert.ok(storybook, "storybook job is required");
  assert.equal(browser.name, "Browser (Vitest browser)");
  assert.equal(webgl.name, "WebGL (deterministic SwiftShader)");
  assert.equal(storybook.name, "Storybook (Vitest browser)");

  assertMeasuredBrowserJob(browser, "browser");
  assertMeasuredBrowserJob(
    webgl,
    "webgl",
    " --file-parallelism false --max-workers 1",
  );
  assertMeasuredBrowserJob(storybook, "storybook");

  const webglCommands = allRunCommands(webgl);

  assert.doesNotMatch(allRunCommands(browser), /--suite storybook/);
  assert.doesNotMatch(allRunCommands(browser), /--suite webgl/);
  assert.doesNotMatch(webglCommands, /--suite browser|--suite storybook/);
  assert.doesNotMatch(allRunCommands(storybook), /--suite browser(?:\s|$)/);
  assert.doesNotMatch(allRunCommands(storybook), /--suite webgl/);
});
