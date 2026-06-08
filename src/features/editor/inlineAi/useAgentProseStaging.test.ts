// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type { PendingProseProposal } from "@/features/agent-writes/proseStagingStore";

/**
 * Regression: when headless auto-apply is ON, an append proposal is applied by
 * the drain/poller and must NOT also be surfaced in the inline-AI diff UI.
 * Showing both caused a double-apply and an "entry is not in proposed status"
 * error when the user clicked Accept on an already-applied (accepted) row.
 */

const h = vi.hoisted(() => ({
  enabled: false,
  proposal: null as PendingProseProposal | null,
  enqueue: vi.fn(),
  clear: vi.fn(),
  loadLatestProposedProse: vi.fn(async () => h.proposal),
  isAutoAcceptEnabled: vi.fn(async () => h.enabled),
}));

vi.mock("@/features/agent-writes/proseStagingStore", () => ({
  useProseStagingStore: (selector: (s: unknown) => unknown) =>
    selector({ pending: null, clear: h.clear, enqueue: h.enqueue }),
}));
vi.mock("@/features/agent-writes/prose", () => ({
  loadLatestProposedProse: h.loadLatestProposedProse,
  agentAcceptProseStage: vi.fn(),
  agentDiscardProseStage: vi.fn(),
}));
vi.mock("@/features/agent-writes/autoAcceptGate", () => ({
  isAutoAcceptEnabled: h.isAutoAcceptEnabled,
  isHeadlessAppliable: (p: { mode: string; anchorText?: string }) =>
    p.mode === "append" || (p.mode === "insert" && !!p.anchorText),
}));
vi.mock("@/features/project/projectStore", () => ({
  getCurrentProjectId: () => "proj-1",
}));
vi.mock("@/features/editor/inlineAi/inlineAiStore", () => ({
  useInlineAiStore: { getState: () => ({ status: "idle" }) },
}));

import { useAgentProseStaging } from "./useAgentProseStaging";

const diffApi = {
  showProvidedText: vi.fn(),
  accept: vi.fn(),
  rejectOrAbort: vi.fn(),
  getActiveStagingId: () => null,
};

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.clearAllMocks();
  h.enabled = false;
  h.proposal = null;
});

describe("useAgentProseStaging — diff-UI surfacing vs auto-apply", () => {
  it("does NOT surface an append proposal when auto-accept is enabled", async () => {
    h.enabled = true;
    h.proposal = {
      stagingId: "s1",
      sceneId: "scene-1",
      text: "x",
      mode: "append",
    };
    renderHook(() => useAgentProseStaging(null, "scene-1", diffApi));
    // The chain must reach the gate decision before we assert non-enqueue.
    await waitFor(() => expect(h.isAutoAcceptEnabled).toHaveBeenCalled());
    await flush();
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it("surfaces an append proposal when auto-accept is disabled", async () => {
    h.enabled = false;
    h.proposal = {
      stagingId: "s1",
      sceneId: "scene-1",
      text: "x",
      mode: "append",
    };
    renderHook(() => useAgentProseStaging(null, "scene-1", diffApi));
    await waitFor(() => expect(h.enqueue).toHaveBeenCalledTimes(1));
  });

  it("surfaces a non-anchored insert (never auto-applied), without a gate check", async () => {
    h.enabled = true;
    h.proposal = {
      stagingId: "s1",
      sceneId: "scene-1",
      text: "x",
      mode: "insert",
    };
    renderHook(() => useAgentProseStaging(null, "scene-1", diffApi));
    await waitFor(() => expect(h.enqueue).toHaveBeenCalledTimes(1));
    expect(h.isAutoAcceptEnabled).not.toHaveBeenCalled();
  });

  it("does NOT surface an anchored insert when auto-accept is enabled", async () => {
    h.enabled = true;
    h.proposal = {
      stagingId: "s1",
      sceneId: "scene-1",
      text: "x",
      mode: "insert",
      anchorText: "somewhere",
    };
    renderHook(() => useAgentProseStaging(null, "scene-1", diffApi));
    await waitFor(() => expect(h.isAutoAcceptEnabled).toHaveBeenCalled());
    await flush();
    expect(h.enqueue).not.toHaveBeenCalled();
  });
});
