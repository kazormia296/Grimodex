import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { load } from "js-yaml";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");

async function read(relativePath) {
  return readFile(path.join(repoRoot, relativePath), "utf8");
}

function stepNamed(job, name) {
  const step = job.steps.find((candidate) => candidate.name === name);
  assert.ok(step, `${name} step is required`);
  return step;
}

async function runInlineGuard(
  script,
  { candidateSha, currentMasterSha, environment = "production" },
) {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "grimodex-deploy-guard-"),
  );
  try {
    const binDirectory = path.join(temporaryRoot, "bin");
    const fakeGit = path.join(binDirectory, "git");
    const outputPath = path.join(temporaryRoot, "github-output");
    await mkdir(binDirectory);
    await writeFile(
      fakeGit,
      `#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  fetch)
    exit 0
    ;;
  rev-parse)
    printf '%s\\n' "\${FAKE_CURRENT_MASTER_SHA:?}"
    ;;
  *)
    printf 'unexpected git command: %s\\n' "$*" >&2
    exit 2
    ;;
esac
`,
      "utf8",
    );
    await chmod(fakeGit, 0o755);

    await execFileAsync("bash", ["-c", script], {
      cwd: temporaryRoot,
      env: {
        ...process.env,
        PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
        CF_PAGES_ENVIRONMENT: environment,
        DEPLOY_CANDIDATE_SHA: candidateSha,
        FAKE_CURRENT_MASTER_SHA: currentMasterSha,
        GITHUB_OUTPUT: outputPath,
      },
    });

    const output = await readFile(outputPath, "utf8");
    const deploy = /^deploy=(true|false)$/m.exec(output)?.[1];
    assert.ok(deploy, `guard did not emit deploy output:\n${output}`);
    return deploy === "true";
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
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

  const preflight = workflow.jobs.preflight;
  const deploy = workflow.jobs.deploy;
  assert.ok(preflight, "preflight job is required");
  assert.ok(deploy, "deploy job is required");
  assert.equal(workflow.concurrency, undefined);
  assert.equal(preflight.concurrency, undefined);
  assert.equal(deploy.needs, "preflight");
  assert.equal(deploy.if, "needs.preflight.outputs.deploy == 'true'");
  assert.equal(
    deploy.concurrency["cancel-in-progress"],
    false,
    "a stale completion must not cancel a current deployment before its SHA guard runs",
  );
  assert.equal(
    deploy.concurrency.queue,
    "max",
    "a late stale completion must not replace a newer pending deployment",
  );
  assert.match(preflight.if, /workflow_run\.conclusion == 'success'/);
  assert.match(preflight.if, /workflow_run\.event == 'push'/);
  assert.match(preflight.if, /workflow_run\.head_branch == 'master'/);
  assert.match(preflight.if, /inputs\.environment != 'production'/);
  assert.match(preflight.if, /github\.ref == 'refs\/heads\/master'/);
  assert.equal(workflow.permissions.contents, "read");

  const candidateExpression =
    "${{ github.event_name == 'workflow_run' && github.event.workflow_run.head_sha || github.sha }}";
  assert.equal(preflight.env.DEPLOY_CANDIDATE_SHA, candidateExpression);
  assert.equal(deploy.env.DEPLOY_CANDIDATE_SHA, candidateExpression);

  const policyCheckout = stepNamed(
    preflight,
    "Checkout current master for deployment preflight",
  );
  assert.equal(policyCheckout.if, "env.CF_PAGES_ENVIRONMENT == 'production'");
  assert.equal(
    policyCheckout.uses,
    "actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5",
  );
  assert.equal(policyCheckout.with.ref, "refs/heads/master");

  const candidateCheckout = stepNamed(deploy, "Checkout deployed revision");
  assert.equal(
    candidateCheckout.uses,
    "actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5",
  );
  assert.equal(candidateCheckout.with.ref, "${{ env.DEPLOY_CANDIDATE_SHA }}");

  const setupPnpm = deploy.steps.find((step) =>
    step.uses?.startsWith("pnpm/action-setup@"),
  );
  assert.equal(
    setupPnpm.uses,
    "pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1",
  );
  assert.equal(setupPnpm.with.version, "10.33.0");

  const setupNode = deploy.steps.find((step) =>
    step.uses?.startsWith("actions/setup-node@"),
  );
  assert.equal(
    setupNode.uses,
    "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
  );
  assert.equal(setupNode.with["node-version"], 22);

  assert.equal(
    deploy.env.CLOUDFLARE_ACCOUNT_ID,
    "${{ secrets.CLOUDFLARE_ACCOUNT_ID }}",
  );
  assert.equal(
    deploy.env.CLOUDFLARE_API_TOKEN,
    "${{ secrets.CLOUDFLARE_API_TOKEN }}",
  );

  const commands = deploy.steps
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

test("production revision is checked before build and immediately before deploy", async () => {
  const workflow = load(
    await read(".github/workflows/cloudflare-editor-deploy.yml"),
  );
  const preflightGuard = stepNamed(
    workflow.jobs.preflight,
    "Verify candidate revision is current master",
  );
  const steps = workflow.jobs.deploy.steps;
  const checkoutIndex = steps.findIndex(
    (step) => step.name === "Checkout deployed revision",
  );
  const earlyGuardIndex = steps.findIndex(
    (step) => step.name === "Verify queued revision is current master",
  );
  const setupPnpmIndex = steps.findIndex((step) =>
    step.uses?.startsWith("pnpm/action-setup@"),
  );
  const setupNodeIndex = steps.findIndex((step) =>
    step.uses?.startsWith("actions/setup-node@"),
  );
  const installIndex = steps.findIndex(
    (step) => step.name === "Install dependencies",
  );
  const credentialsIndex = steps.findIndex(
    (step) => step.name === "Verify Cloudflare credentials",
  );
  const buildIndex = steps.findIndex(
    (step) => step.name === "Build Web Editor",
  );
  const finalGuardIndex = steps.findIndex(
    (step) => step.name === "Verify deployed revision is current master",
  );
  const deployIndex = steps.findIndex(
    (step) => step.name === "Deploy Web Editor",
  );

  assert.ok(checkoutIndex >= 0, "candidate checkout is required");
  assert.equal(
    earlyGuardIndex,
    checkoutIndex + 1,
    "queued revision must be checked immediately after checkout",
  );
  assert.ok(earlyGuardIndex < setupPnpmIndex);
  assert.ok(earlyGuardIndex < setupNodeIndex);
  assert.ok(earlyGuardIndex < installIndex);
  assert.ok(earlyGuardIndex < credentialsIndex);
  assert.ok(earlyGuardIndex < buildIndex);
  assert.ok(finalGuardIndex > buildIndex);
  assert.equal(
    deployIndex,
    finalGuardIndex + 1,
    "final master guard must run immediately before deployment",
  );

  const earlyGuard = steps[earlyGuardIndex];
  const finalGuard = steps[finalGuardIndex];
  assert.equal(earlyGuard.id, "queued_current_master");
  assert.equal(finalGuard.id, "current_master");
  assert.equal(
    finalGuard.if,
    "steps.queued_current_master.outputs.deploy == 'true'",
  );
  for (const guard of [earlyGuard, finalGuard]) {
    assert.match(
      guard.run,
      /git fetch --no-tags origin \+refs\/heads\/master:refs\/remotes\/origin\/master/,
    );
    assert.match(guard.run, /git rev-parse refs\/remotes\/origin\/master/);
  }

  for (const guard of [preflightGuard, earlyGuard, finalGuard]) {
    assert.doesNotMatch(
      guard.run,
      /scripts\/cloudflare-editor-deploy-guard\.mjs/,
      "deployment policy must not execute code from the candidate checkout",
    );
    assert.match(guard.run, /\^\[0-9a-fA-F\]\{40\}\$/);
    assert.match(guard.run, /\^\[0-9a-fA-F\]\{64\}\$/);
    assert.equal(
      await runInlineGuard(guard.run, {
        candidateSha: "b".repeat(40),
        currentMasterSha: "b".repeat(40),
      }),
      true,
    );
    assert.equal(
      await runInlineGuard(guard.run, {
        candidateSha: "a".repeat(40),
        currentMasterSha: "b".repeat(40),
      }),
      false,
    );
    assert.equal(
      await runInlineGuard(guard.run, {
        candidateSha: "not-a-sha",
        currentMasterSha: "not-a-sha",
      }),
      false,
    );
  }

  for (const index of [
    setupPnpmIndex,
    setupNodeIndex,
    installIndex,
    credentialsIndex,
    buildIndex,
  ]) {
    assert.equal(
      steps[index].if,
      "steps.queued_current_master.outputs.deploy == 'true'",
      `${steps[index].name ?? steps[index].uses} must skip stale queued runs`,
    );
  }
  assert.equal(
    steps[deployIndex].if,
    "steps.current_master.outputs.deploy == 'true'",
  );
  assert.equal(
    await runInlineGuard(earlyGuard.run, {
      candidateSha: "b".repeat(40),
      currentMasterSha: "b".repeat(40),
    }),
    true,
  );
  assert.equal(
    await runInlineGuard(finalGuard.run, {
      candidateSha: "b".repeat(40),
      currentMasterSha: "c".repeat(40),
    }),
    false,
    "a master update during the build must block deployment",
  );
});

test("a stale manual production rerun is rejected while staging remains selectable", async () => {
  const workflow = load(
    await read(".github/workflows/cloudflare-editor-deploy.yml"),
  );
  const preflight = workflow.jobs.preflight;
  const preflightGuard = stepNamed(
    preflight,
    "Verify candidate revision is current master",
  );

  assert.equal(
    await runInlineGuard(preflightGuard.run, {
      candidateSha: "a".repeat(40),
      currentMasterSha: "b".repeat(40),
      environment: "production",
    }),
    false,
  );
  assert.equal(
    await runInlineGuard(preflightGuard.run, {
      candidateSha: "a".repeat(40),
      currentMasterSha: "b".repeat(40),
      environment: "staging",
    }),
    true,
  );
  assert.doesNotMatch(
    stepNamed(workflow.jobs.deploy, "Deploy Web Editor").if,
    /github\.event_name == 'workflow_dispatch'/,
  );
});

test("reverse CI completion order preserves the newest pending deployment", async () => {
  const workflow = load(
    await read(".github/workflows/cloudflare-editor-deploy.yml"),
  );
  const deploy = workflow.jobs.deploy;
  const preflightGuard = stepNamed(
    workflow.jobs.preflight,
    "Verify candidate revision is current master",
  );
  const currentPendingSha = "c".repeat(40);
  const lateStaleSha = "a".repeat(40);

  assert.equal(deploy.concurrency["cancel-in-progress"], false);
  assert.equal(deploy.concurrency.queue, "max");
  assert.equal(
    await runInlineGuard(preflightGuard.run, {
      candidateSha: currentPendingSha,
      currentMasterSha: currentPendingSha,
    }),
    true,
  );
  assert.equal(
    await runInlineGuard(preflightGuard.run, {
      candidateSha: lateStaleSha,
      currentMasterSha: currentPendingSha,
    }),
    false,
  );
});
