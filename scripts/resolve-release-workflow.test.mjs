import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  RELEASE_BUILD_TARGETS,
  resolveReleaseWorkflow,
} from "./resolve-release-workflow.mjs";

const base = {
  eventName: "workflow_dispatch",
  refName: "master",
  refType: "branch",
  packageVersion: "2.0.7",
  basePackageVersion: "2.0.7",
  expectedMajor: 2,
  defaultBranch: "master",
  candidateRef: "1111111111111111111111111111111111111111",
  candidateSha: "1111111111111111111111111111111111111111",
  publishRequested: false,
  recoverDraftRequested: false,
  sourceRunId: "",
};

describe("resolveReleaseWorkflow", () => {
  it("keeps tag pushes as the only publishing full-release path", () => {
    const result = resolveReleaseWorkflow({
      ...base,
      eventName: "push",
      refName: "v2.0.7",
      refType: "tag",
      candidateRef: "",
      candidateSha: "2222222222222222222222222222222222222222",
      target: "",
    });

    assert.deepEqual(result, {
      mode: "release",
      tag: "v2.0.7",
      version: "2.0.7",
      major: 2,
      prerelease: false,
      target: "all",
      runBuild: true,
      shouldPublish: true,
      recoverDraft: false,
      sourceRunId: "",
      candidateRef: "v2.0.7",
      candidateSha: "2222222222222222222222222222222222222222",
      checkoutRef: "v2.0.7",
      matrix: { include: RELEASE_BUILD_TARGETS },
    });
  });

  it("selects one non-secret host build at a fixed candidate SHA without publishing", () => {
    const result = resolveReleaseWorkflow({
      ...base,
      target: "windows",
    });

    assert.equal(result.mode, "debug");
    assert.equal(result.tag, "v2.0.7");
    assert.equal(result.target, "windows");
    assert.equal(result.runBuild, true);
    assert.equal(result.shouldPublish, false);
    assert.equal(result.candidateRef, base.candidateSha);
    assert.equal(result.checkoutRef, base.candidateSha);
    assert.deepEqual(
      result.matrix.include.map((entry) => entry.id),
      ["windows"],
    );
  });

  it("allows secret-backed mac and all targets only on the trusted default branch", () => {
    for (const target of ["mac", "all"]) {
      assert.throws(
        () => resolveReleaseWorkflow({ ...base, target }),
        /candidate ref.*default branch/i,
      );
    }

    const result = resolveReleaseWorkflow({
      ...base,
      candidateRef: "master",
      target: "mac",
    });
    assert.deepEqual(
      result.matrix.include.map((entry) => entry.id),
      ["mac"],
    );
    assert.equal(result.shouldPublish, false);
  });

  it("reuses a completed source run for a read-only publish-stage debug", () => {
    const result = resolveReleaseWorkflow({
      ...base,
      candidateRef: "master",
      target: "publish",
      sourceRunId: "30173105309",
    });

    assert.equal(result.target, "publish");
    assert.equal(result.runBuild, false);
    assert.equal(result.shouldPublish, false);
    assert.equal(result.recoverDraft, false);
    assert.equal(result.sourceRunId, "30173105309");
    assert.deepEqual(result.matrix, { include: [] });
  });

  it("allows draft recovery only for a safe publish-stage dispatch", () => {
    const result = resolveReleaseWorkflow({
      ...base,
      candidateRef: "master",
      target: "publish",
      sourceRunId: "30173105309",
      recoverDraftRequested: true,
    });

    assert.equal(result.target, "publish");
    assert.equal(result.shouldPublish, false);
    assert.equal(result.recoverDraft, true);

    for (const target of ["windows", "linux", "mac", "all"]) {
      assert.throws(
        () =>
          resolveReleaseWorkflow({
            ...base,
            candidateRef:
              target === "windows" || target === "linux"
                ? base.candidateRef
                : "master",
            target,
            recoverDraftRequested: true,
          }),
        /draft recovery.*publish target/i,
      );
    }
  });

  it("fails closed for unsafe or incomplete manual publish requests", () => {
    assert.throws(
      () =>
        resolveReleaseWorkflow({
          ...base,
          candidateRef: "master",
          target: "publish",
        }),
      /source run ID/,
    );
    assert.throws(
      () =>
        resolveReleaseWorkflow({
          ...base,
          candidateRef: "master",
          target: "publish",
          sourceRunId: "not-a-run",
        }),
      /source run ID/,
    );
    assert.throws(
      () =>
        resolveReleaseWorkflow({
          ...base,
          target: "windows",
          publishRequested: true,
        }),
      /cannot publish/,
    );
    assert.throws(
      () =>
        resolveReleaseWorkflow({
          ...base,
          target: "windows",
          sourceRunId: "30173105309",
        }),
      /only valid for the publish target/,
    );
    assert.throws(
      () =>
        resolveReleaseWorkflow({
          ...base,
          candidateRef: "master",
          target: "publish",
          sourceRunId: "30173105309",
          recoverDraftRequested: "not-a-boolean",
        }),
      /recover_draft must be true or false/,
    );
    assert.throws(
      () =>
        resolveReleaseWorkflow({
          ...base,
          candidateRef: "master",
          target: "publish",
          sourceRunId: "30173105309",
          packageVersion: "2.0.7-beta.1",
          basePackageVersion: "2.0.7-beta.1",
          recoverDraftRequested: true,
        }),
      /stable version/,
    );
  });

  it("requires the trusted dispatcher ref and an immutable candidate SHA", () => {
    assert.throws(
      () =>
        resolveReleaseWorkflow({
          ...base,
          refName: "fix/windows-release",
          target: "windows",
        }),
      /dispatch.*default branch/i,
    );
    assert.throws(
      () =>
        resolveReleaseWorkflow({
          ...base,
          candidateSha: "not-a-sha",
          target: "windows",
        }),
      /candidate SHA/i,
    );
    assert.throws(
      () =>
        resolveReleaseWorkflow({
          ...base,
          candidateRef: "fix/windows-release",
          target: "windows",
        }),
      /default branch or a full 40-character commit SHA/i,
    );
    assert.throws(
      () =>
        resolveReleaseWorkflow({
          ...base,
          candidateRef: "2222222222222222222222222222222222222222",
          target: "windows",
        }),
      /does not match the checked out candidate SHA/i,
    );
    assert.throws(
      () =>
        resolveReleaseWorkflow({
          ...base,
          packageVersion: "2.0.8",
          target: "windows",
        }),
      /must not change package\.json version/,
    );
  });

  it("preserves the exact tag gate for production releases", () => {
    assert.throws(
      () =>
        resolveReleaseWorkflow({
          ...base,
          eventName: "push",
          refName: "v2.0.7",
          refType: "tag",
          candidateRef: "",
          publishRequested: true,
          target: "",
        }),
      /cannot publish/,
    );
    assert.throws(
      () =>
        resolveReleaseWorkflow({
          ...base,
          eventName: "push",
          refName: "v2.0.8",
          refType: "tag",
          candidateRef: "",
          target: "",
        }),
      /must exactly match/,
    );
    assert.throws(
      () =>
        resolveReleaseWorkflow({
          ...base,
          eventName: "push",
          refName: "master",
          refType: "branch",
          candidateRef: "",
          target: "",
        }),
      /tag ref/,
    );
  });
});

describe("resolve-release-workflow CLI", () => {
  it("accepts --recover-draft and writes recover_draft to GITHUB_OUTPUT", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "grimodex-release-resolver-"),
    );
    try {
      const packagePath = path.join(directory, "package.json");
      const outputPath = path.join(directory, "github-output.txt");
      await writeFile(packagePath, '{"version":"2.0.7"}\n', "utf8");

      const scriptPath = fileURLToPath(
        new URL("./resolve-release-workflow.mjs", import.meta.url),
      );
      const result = spawnSync(
        process.execPath,
        [
          scriptPath,
          "--event",
          "workflow_dispatch",
          "--ref-name",
          "master",
          "--ref-type",
          "branch",
          "--package",
          packagePath,
          "--base-package",
          packagePath,
          "--major",
          "2",
          "--default-branch",
          "master",
          "--candidate-ref",
          "master",
          "--candidate-sha",
          "1111111111111111111111111111111111111111",
          "--target",
          "publish",
          "--publish",
          "false",
          "--recover-draft",
          "true",
          "--source-run-id",
          "30173105309",
        ],
        {
          encoding: "utf8",
          env: { ...process.env, GITHUB_OUTPUT: outputPath },
        },
      );

      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).recoverDraft, true);
      assert.match(await readFile(outputPath, "utf8"), /^recover_draft=true$/m);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
