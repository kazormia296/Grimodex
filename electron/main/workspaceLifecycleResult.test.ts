import { describe, expect, it } from "vitest";

import {
  normalizeWorkspaceLifecycleResult,
  type WorkspaceLifecycleBinding,
  type WorkspaceLifecycleObservation,
} from "./workspaceLifecycleResult.js";

const bindingA: WorkspaceLifecycleBinding = {
  workspaceId: "workspace-a",
  authorityId: "authority-a",
  generation: 7,
};

const bindingB: WorkspaceLifecycleBinding = {
  workspaceId: "workspace-b",
  authorityId: "authority-b",
  generation: 8,
};

function readySnapshot(
  revision: number,
  binding: WorkspaceLifecycleBinding = bindingA,
) {
  return {
    state: "ready" as const,
    revision,
    binding,
  };
}

describe("workspace lifecycle result contract", () => {
  it("keeps a NotAdmitted restore from reviving the binding while another open is transitioning", () => {
    const result = normalizeWorkspaceLifecycleResult({
      status: "not-admitted",
      reasonCode: "transition",
      snapshot: {
        state: "transition",
        phase: "replacing",
        revision: 12,
      },
    });

    expect(result).toEqual({
      status: "not-admitted",
      reasonCode: "transition",
      snapshot: {
        state: "transition",
        phase: "replacing",
        revision: 12,
      },
      resume: "blocked",
    });
    expect(result).not.toHaveProperty("binding");
  });

  it("marks an Unchanged response stale after a newer lifecycle revision is observed", () => {
    const observed: WorkspaceLifecycleObservation = {
      state: "transition",
      revision: 13,
    };

    const result = normalizeWorkspaceLifecycleResult(
        {
          status: "unchanged",
          binding: bindingA,
          operationOutcome: "succeeded",
          contentEffect: "none",
          snapshot: readySnapshot(12),
      },
      observed,
    );

    expect(result.status).toBe("unchanged");
    expect(result.resume).toBe("blocked");
    if (result.status !== "unchanged") throw new Error("expected unchanged");
    expect(result.binding).toEqual(bindingA);
  });

  it("accepts an Unchanged response only for the exact binding at the current revision", () => {
    const result = normalizeWorkspaceLifecycleResult(
        {
          status: "unchanged",
          binding: bindingA,
          operationOutcome: "succeeded",
          contentEffect: "none",
          snapshot: readySnapshot(12),
      },
      {
        state: "ready",
        revision: 12,
        binding: bindingA,
      },
    );

    expect(result.resume).toBe("same-binding");
  });

  it("does not treat a same-revision different authority as Unchanged", () => {
    expect(() =>
      normalizeWorkspaceLifecycleResult(
        {
          status: "unchanged",
          binding: bindingA,
          operationOutcome: "succeeded",
          contentEffect: "none",
          snapshot: readySnapshot(12, bindingB),
        },
        {
          state: "ready",
          revision: 12,
          binding: bindingA,
        },
      ),
    ).toThrow(/must match a ready snapshot binding/);
  });

  it("keeps restored requires-open distinct from an activated ready binding", () => {
    const restored = normalizeWorkspaceLifecycleResult({
      status: "restored",
      activation: "requires-open",
      operationOutcome: "succeeded",
      contentEffect: "retained",
      snapshot: {
        state: "recovery-required",
        revision: 22,
      },
    });

    expect(restored).toEqual({
      status: "restored",
      activation: "requires-open",
      operationOutcome: "succeeded",
      contentEffect: "retained",
      snapshot: {
        state: "recovery-required",
        revision: 22,
      },
      resume: "requires-open",
    });
    expect(restored).not.toHaveProperty("binding");

    const activated = normalizeWorkspaceLifecycleResult({
      status: "activated",
      activation: "ready",
      operationOutcome: "failed",
      contentEffect: "retained",
      binding: bindingB,
      snapshot: readySnapshot(23, bindingB),
    });

    expect(activated).toMatchObject({
      status: "activated",
      activation: "ready",
      operationOutcome: "failed",
      contentEffect: "retained",
      binding: bindingB,
      resume: "activated",
    });
  });

  it.each([
    {
      name: "unknown result status",
      value: { status: "ready", snapshot: readySnapshot(1) },
    },
    {
      name: "transition without a phase",
      value: {
        status: "not-admitted",
        reasonCode: "busy",
        snapshot: { state: "transition", revision: 1 },
      },
    },
    {
      name: "requires-open carrying a binding",
      value: {
        status: "restored",
        activation: "requires-open",
        operationOutcome: "succeeded",
        contentEffect: "retained",
        binding: bindingA,
        snapshot: { state: "recovery-required", revision: 1 },
      },
    },
    {
      name: "activated result with no workspace effect",
      value: {
        status: "activated",
        activation: "ready",
        operationOutcome: "succeeded",
        contentEffect: "none",
        binding: bindingA,
        snapshot: readySnapshot(2),
      },
    },
    {
      name: "requires-open restoration that replaces content",
      value: {
        status: "restored",
        activation: "requires-open",
        operationOutcome: "failed",
        contentEffect: "replaced",
        snapshot: { state: "recovery-required", revision: 3 },
      },
    },
  ])("rejects $name", ({ value }) => {
    expect(() => normalizeWorkspaceLifecycleResult(value)).toThrow(
      /invalid workspace lifecycle result/,
    );
  });
});
