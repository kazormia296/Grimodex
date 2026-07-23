import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { load } from "js-yaml";
import { isCurrentMasterDeployment } from "./cloudflare-editor-deploy-guard.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");

async function read(relativePath) {
  return readFile(path.join(repoRoot, relativePath), "utf8");
}

test("Cloudflare Pages deploy waits for successful master CI", async () => {
  const workflow = load(
    await read(".github/workflows/cloudflare-editor-deploy.yml"),
  );

  assert.equal(workflow.name, "Cloudflare Web Editor Deploy");
  assert.deepEqual(workflow.on.workflow_run.workflows, ["CI"]);
  assert.deepEqual(workflow.on.workflow_run.branches, ["master"]);
  assert.deepEqual(workflow.on.workflow_run.types, ["completed"]);

  const manualInput = workflow.on.workflow_dispatch.inputs.environment;
  assert.equal(manualInput.type, "choice");
  assert.equal(manualInput.required, true);
  assert.equal(manualInput.default, "staging");
  assert.deepEqual(manualInput.options, ["staging", "production"]);

  const job = workflow.jobs.deploy;
  assert.ok(job, "deploy job is required");
  assert.equal(
    workflow.concurrency["cancel-in-progress"],
    false,
    "a stale completion must not cancel a current deployment before its SHA guard runs",
  );
  assert.match(job.if, /workflow_run\.conclusion == 'success'/);
  assert.match(job.if, /workflow_run\.event == 'push'/);
  assert.match(job.if, /workflow_run\.head_branch == 'master'/);
  assert.match(job.if, /inputs\.environment != 'production'/);
  assert.match(job.if, /github\.ref == 'refs\/heads\/master'/);
  assert.equal(workflow.permissions.contents, "read");

  const checkout = job.steps.find((step) =>
    step.uses?.startsWith("actions/checkout@"),
  );
  assert.equal(
    checkout.uses,
    "actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5",
  );
  assert.match(checkout.with.ref, /workflow_run\.head_sha/);

  const setupPnpm = job.steps.find((step) =>
    step.uses?.startsWith("pnpm/action-setup@"),
  );
  assert.equal(
    setupPnpm.uses,
    "pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1",
  );
  assert.equal(setupPnpm.with.version, "10.33.0");

  const setupNode = job.steps.find((step) =>
    step.uses?.startsWith("actions/setup-node@"),
  );
  assert.equal(
    setupNode.uses,
    "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
  );
  assert.equal(setupNode.with["node-version"], 22);

  assert.equal(
    job.env.CLOUDFLARE_ACCOUNT_ID,
    "${{ secrets.CLOUDFLARE_ACCOUNT_ID }}",
  );
  assert.equal(
    job.env.CLOUDFLARE_API_TOKEN,
    "${{ secrets.CLOUDFLARE_API_TOKEN }}",
  );

  const commands = job.steps
    .map((step) => step.run)
    .filter(Boolean)
    .join("\n");
  assert.match(commands, /pnpm install --frozen-lockfile/);
  assert.match(
    commands,
    /pnpm editor:cloudflare web-build "\$CF_PAGES_ENVIRONMENT"/,
  );
  assert.match(
    commands,
    /pnpm editor:cloudflare web-deploy-artifact "\$CF_PAGES_ENVIRONMENT"/,
  );
});

test("a stale CI completion cannot deploy after master advances", async () => {
  const olderSha = "a".repeat(40);
  const newerSha = "b".repeat(40);
  assert.equal(isCurrentMasterDeployment(olderSha, newerSha), false);
  assert.equal(isCurrentMasterDeployment(newerSha, newerSha), true);
  assert.equal(isCurrentMasterDeployment("", ""), false);
  assert.equal(isCurrentMasterDeployment("not-a-sha", "not-a-sha"), false);

  const workflow = load(
    await read(".github/workflows/cloudflare-editor-deploy.yml"),
  );
  const steps = workflow.jobs.deploy.steps;
  const buildIndex = steps.findIndex(
    (step) => step.name === "Build Web Editor",
  );
  const guardIndex = steps.findIndex(
    (step) => step.name === "Verify deployed revision is current master",
  );
  const deployIndex = steps.findIndex(
    (step) => step.name === "Deploy Web Editor",
  );

  assert.ok(buildIndex >= 0, "build step is required");
  assert.ok(guardIndex > buildIndex, "master guard must run after the build");
  assert.equal(
    deployIndex,
    guardIndex + 1,
    "master guard must run immediately before deployment",
  );

  const guard = steps[guardIndex];
  assert.equal(guard.id, "current_master");
  assert.equal(guard.if, "github.event_name == 'workflow_run'");
  assert.equal(
    guard.env.WORKFLOW_RUN_HEAD_SHA,
    "${{ github.event.workflow_run.head_sha }}",
  );
  assert.match(
    guard.run,
    /git fetch --no-tags origin \+refs\/heads\/master:refs\/remotes\/origin\/master/,
  );
  assert.match(guard.run, /git rev-parse refs\/remotes\/origin\/master/);
  assert.match(guard.run, /node scripts\/cloudflare-editor-deploy-guard\.mjs/);
  assert.match(guard.run, /"\$WORKFLOW_RUN_HEAD_SHA"/);
  assert.match(guard.run, /"\$current_master_sha"/);

  const deploy = steps[deployIndex];
  assert.match(deploy.if, /github\.event_name == 'workflow_dispatch'/);
  assert.match(deploy.if, /steps\.current_master\.outputs\.deploy == 'true'/);
});
