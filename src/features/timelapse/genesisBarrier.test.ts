// @vitest-environment happy-dom
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { beforeEach, describe, expect, it } from "vitest";
import { replayEditorSteps, type ReplayEvent } from "./replayEngine";
import {
  _resetTimelapseGenesisBarriersForTests,
  abortTimelapseGenesisBarriers,
  awaitTimelapseGenesisBarrier,
  awaitTimelapseGenesisCaptureBarrier,
  beginTimelapseGenesisBarrier,
  runAfterTimelapseGenesis,
} from "./genesisBarrier";
import { publishCurrentProjectId } from "@/application/project/currentProjectAuthority";
import { setCurrentWorkspaceIdentity } from "@/runtime/workspaceIdentity";
import { _resetMutationAuthorityForTests } from "@/features/concurrency/mutationAuthority";
import { _resetQuiescenceLeasesForTests } from "@/application/lifecycle/quiescenceLease";

function begin(projectId: string) {
  publishCurrentProjectId(projectId);
  setCurrentWorkspaceIdentity({ path: "/workspace.gdx", openRevision: 1 });
  return beginTimelapseGenesisBarrier(projectId);
}

beforeEach(() => {
  _resetQuiescenceLeasesForTests();
  _resetMutationAuthorityForTests();
  _resetTimelapseGenesisBarriersForTests();
});

describe("timelapse genesis barrier", () => {
  it("keeps writers pending until the exact activation owner completes", async () => {
    const lease = begin("project-a");
    let settled = false;
    const waiter = awaitTimelapseGenesisBarrier("project-a").then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);

    lease.complete();
    await waiter;

    expect(settled).toBe(true);
    await expect(
      awaitTimelapseGenesisBarrier("project-a"),
    ).resolves.toBeUndefined();
  });

  it("fails closed and preserves the original initialization cause", async () => {
    const lease = begin("project-failed");
    const cause = new Error("genesis write failed");
    const pendingFailure = expect(
      awaitTimelapseGenesisBarrier("project-failed"),
    ).rejects.toMatchObject({
      name: "TimelapseGenesisBarrierError",
      cause,
    });

    lease.fail(cause);

    await pendingFailure;
    await expect(
      awaitTimelapseGenesisBarrier("project-failed"),
    ).rejects.toMatchObject({
      name: "TimelapseGenesisBarrierError",
      cause,
    });
  });

  it("replaces a failed activation for retry without discarding captured events", async () => {
    const failed = begin("project-retry");
    failed.fail(new Error("first attempt"));

    const retry = begin("project-retry");
    expect(retry.preservesCapturedEvents).toBe(true);

    let settled = false;
    const waiter = awaitTimelapseGenesisBarrier("project-retry").then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    retry.complete();
    await waiter;
    expect(settled).toBe(true);
  });

  it("rejects an old waiter and prevents a superseded owner from releasing the replacement", async () => {
    const oldLease = begin("project-switch");
    const oldWaiter = expect(
      awaitTimelapseGenesisBarrier("project-switch"),
    ).rejects.toThrow("superseded by a newer activation");

    const currentLease = begin("project-switch");
    await oldWaiter;
    expect(currentLease.preservesCapturedEvents).toBe(false);

    let currentSettled = false;
    const currentWaiter = awaitTimelapseGenesisBarrier("project-switch").then(
      () => {
        currentSettled = true;
      },
    );
    oldLease.complete();
    oldLease.fail(new Error("stale failure"));
    oldLease.abort("stale abort");
    await Promise.resolve();
    expect(currentSettled).toBe(false);

    currentLease.complete();
    await currentWaiter;
    expect(currentSettled).toBe(true);
  });

  it("rejects the active waiter on teardown abort and reset clears failed states", async () => {
    const superseded = begin("project-a");
    const waiterA = expect(
      awaitTimelapseGenesisBarrier("project-a"),
    ).rejects.toThrow("superseded by another Project activation");
    begin("project-b");
    const waiterB = expect(
      awaitTimelapseGenesisBarrier("project-b"),
    ).rejects.toThrow("renderer teardown");

    abortTimelapseGenesisBarriers("renderer teardown");
    await Promise.all([waiterA, waiterB]);
    superseded.abort("stale abort");

    _resetTimelapseGenesisBarriersForTests();
    publishCurrentProjectId("project-a");
    await expect(
      awaitTimelapseGenesisBarrier("project-a"),
    ).resolves.toBeUndefined();
    publishCurrentProjectId("project-b");
    await expect(
      awaitTimelapseGenesisBarrier("project-b"),
    ).resolves.toBeUndefined();
  });

  it("rejects stale project authority even when no genesis state exists", async () => {
    publishCurrentProjectId("project-current");
    setCurrentWorkspaceIdentity({ path: "/workspace.gdx", openRevision: 1 });

    await expect(awaitTimelapseGenesisBarrier("project-stale")).rejects.toThrow(
      "mutation authority is not current",
    );
  });

  it("lets the recorder target queue await activation ahead of the old UI authority", async () => {
    publishCurrentProjectId("project-old");
    setCurrentWorkspaceIdentity({
      path: "/workspace-old.gdx",
      openRevision: 1,
    });
    const lease = beginTimelapseGenesisBarrier("project-target");
    let settled = false;
    const waiter = awaitTimelapseGenesisCaptureBarrier("project-target").then(
      () => {
        settled = true;
      },
    );

    await Promise.resolve();
    expect(settled).toBe(false);
    lease.complete();
    await waiter;
    expect(settled).toBe(true);
  });

  it("keeps capture waits scoped to the synchronously published target", async () => {
    publishCurrentProjectId("project-old");
    setCurrentWorkspaceIdentity({
      path: "/workspace-old.gdx",
      openRevision: 1,
    });
    const lease = beginTimelapseGenesisBarrier("project-target");

    await expect(
      awaitTimelapseGenesisCaptureBarrier("project-other"),
    ).rejects.toThrow("capture authority is not current");
    lease.complete();
  });

  it("does not invoke a writer after a same-project-id Workspace replacement in the resolved barrier gap", async () => {
    publishCurrentProjectId("same-project");
    setCurrentWorkspaceIdentity({ path: "/workspace-a.gdx", openRevision: 1 });
    let invoked = false;

    const write = runAfterTimelapseGenesis("same-project", async () => {
      invoked = true;
      return "written";
    });
    setCurrentWorkspaceIdentity({ path: "/workspace-b.gdx", openRevision: 2 });

    await expect(write).rejects.toThrow(
      "mutation authority changed before write",
    );
    expect(invoked).toBe(false);
  });
});

describe("timelapse genesis race counterexample", () => {
  it("double-applies a queued insert when genesis captures the already-committed body", () => {
    const live = new Editor({
      extensions: [StarterKit],
      content: "<p></p>",
    });
    const captured: ReplayEvent[] = [];
    live.on("transaction", ({ transaction }) => {
      if (!transaction.docChanged) return;
      captured.push({
        domain: "editor",
        opType: "doc.step",
        payload: JSON.stringify({
          steps: transaction.steps.map((step) => step.toJSON()),
        }),
        sequence: captured.length + 1,
      });
    });

    live.commands.insertContent("X");
    const committedBody = live.state.doc.toJSON();
    const genesis = new Editor({
      extensions: [StarterKit],
      content: committedBody,
    });

    try {
      expect(captured).toHaveLength(1);
      const replayed = replayEditorSteps(
        genesis.schema,
        genesis.state.doc,
        captured,
      );

      expect(replayed.failedAt).toBeUndefined();
      expect(replayed.appliedSteps).toBe(1);
      expect(replayed.doc.toJSON()).not.toEqual(committedBody);
      expect(replayed.doc.textContent).toBe("XX");
    } finally {
      genesis.destroy();
      live.destroy();
    }
  });
});
