import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetMutationAuthorityForTests,
  awaitPendingAuthoritativeMutations,
  captureMutationAuthority,
  runAuthoritativeMutation,
} from "./mutationAuthority";
import {
  _resetQuiescenceLeasesForTests,
  acquireQuiescenceLease,
} from "@/application/lifecycle/quiescenceLease";
import {
  _resetQuiescenceParticipantsForTests,
  flushQuiescenceParticipants,
  registerQuiescenceParticipant,
} from "@/application/lifecycle/quiescenceParticipants";

const runtime = vi.hoisted(() => ({
  projectId: "project-a",
  workspace: { path: "/a", openRevision: 1 } as {
    path: string;
    openRevision: number;
  } | null,
}));

vi.mock("@/runtime/workspaceIdentity", () => ({
  getCurrentWorkspaceIdentity: () => runtime.workspace,
}));

describe("mutation authority", () => {
  beforeEach(() => {
    runtime.projectId = "project-a";
    runtime.workspace = { path: "/a", openRevision: 1 };
    _resetMutationAuthorityForTests();
    _resetQuiescenceLeasesForTests();
    _resetQuiescenceParticipantsForTests();
  });

  it("rejects a new mutation before invoking it while lifecycle quiescence is leased", async () => {
    const authority = captureMutationAuthority(
      runtime.projectId,
      () => runtime.projectId,
    );
    const mutation = vi.fn(async () => "committed");
    const lease = acquireQuiescenceLease("window-close");

    await expect(
      runAuthoritativeMutation(authority, mutation),
    ).resolves.toEqual({ status: "stale" });
    expect(mutation).not.toHaveBeenCalled();
    await expect(awaitPendingAuthoritativeMutations()).resolves.toBeUndefined();

    lease.release();
  });

  it("admits a registered preexisting draft while rejecting unrelated leased mutations", async () => {
    const authority = captureMutationAuthority(
      runtime.projectId,
      () => runtime.projectId,
    );
    const draftMutation = vi.fn(async () => "draft committed");
    const unrelatedMutation = vi.fn(async () => "unrelated committed");
    const unregister = registerQuiescenceParticipant({
      id: "preexisting-draft",
      flush: async () => {
        const outcome = await runAuthoritativeMutation(
          authority,
          draftMutation,
        );
        if (outcome.status !== "current") {
          throw new Error("preexisting draft lost authority");
        }
      },
    });
    const lease = acquireQuiescenceLease("window-close");

    await expect(flushQuiescenceParticipants()).resolves.toBeUndefined();
    expect(draftMutation).toHaveBeenCalledOnce();
    await expect(
      runAuthoritativeMutation(authority, unrelatedMutation),
    ).resolves.toEqual({ status: "stale" });
    expect(unrelatedMutation).not.toHaveBeenCalled();

    unregister();
    lease.release();
  });

  it("keeps an explicit preexisting draft admitted across fixed-point awaits", async () => {
    const authority = captureMutationAuthority(
      runtime.projectId,
      () => runtime.projectId,
    );
    const lease = acquireQuiescenceLease("window-close");
    await Promise.resolve();

    await expect(
      runAuthoritativeMutation(authority, async () => "latest draft", {
        preexistingDraft: true,
      }),
    ).resolves.toEqual({ status: "current", value: "latest draft" });

    lease.release();
  });

  it("marks a completion stale after same-path workspace reopen", async () => {
    const authority = captureMutationAuthority(
      runtime.projectId,
      () => runtime.projectId,
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const mutation = runAuthoritativeMutation(authority, async () => {
      await gate;
      return "committed";
    });

    runtime.workspace = { path: "/a", openRevision: 2 };
    release();
    await expect(mutation).resolves.toEqual({
      status: "stale",
      value: "committed",
    });
  });

  it("keeps quiescence pending until the actual mutation settles", async () => {
    const authority = captureMutationAuthority(
      runtime.projectId,
      () => runtime.projectId,
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    void runAuthoritativeMutation(authority, () => gate);
    let settled = false;
    const wait = awaitPendingAuthoritativeMutations().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await wait;
    expect(settled).toBe(true);
  });
});
