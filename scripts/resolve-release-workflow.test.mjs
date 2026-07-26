import assert from "node:assert/strict";
import { describe, it } from "node:test";

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
    assert.equal(result.sourceRunId, "30173105309");
    assert.deepEqual(result.matrix, { include: [] });
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
