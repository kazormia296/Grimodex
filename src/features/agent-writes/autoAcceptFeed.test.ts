import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PendingProseProposal } from "@/features/agent-writes/proseStagingStore";

/**
 * The auto-accept consumer must stay OFF unless the user opted in AND the
 * project's bodyWrite policy is on, must only consume appendable proposals
 * (insert/replace fall back to human review), and must drain the backlog.
 */

type Handler = (
  proposal: PendingProseProposal,
  projectId: string,
) => boolean | Promise<boolean>;

const h = vi.hoisted(() => ({
  state: {
    toggleOn: false,
    bodyWriteOn: true,
    outcome: { applied: true } as { applied: boolean; reason?: string },
    backlog: [] as PendingProseProposal[],
  },
  handler: null as Handler | null,
  getProject: vi.fn(async () => ({ aiPolicy: "" })),
  autoApplyProseProposal: vi.fn(
    async (_p: PendingProseProposal) => h.state.outcome,
  ),
  loadAllProposedProse: vi.fn(async () => h.state.backlog),
}));

vi.mock("@/features/project/api", () => ({ getProject: h.getProject }));
vi.mock("@/features/ai-policy/parse", () => ({
  isBodyWriteDisabled: () => !h.state.bodyWriteOn,
}));
vi.mock("@/features/settings/settingsStore", () => ({
  useSettingsStore: {
    getState: () => ({ getBoolean: () => h.state.toggleOn }),
  },
}));
vi.mock("@/features/concurrency/externalWriteFeed", () => ({
  setProseProposalHandler: (fn: Handler | null) => {
    h.handler = fn;
  },
}));
vi.mock("@/features/agent-writes/prose", () => ({
  loadAllProposedProse: h.loadAllProposedProse,
}));
vi.mock("@/features/agent-writes/autoApplyProse", () => ({
  autoApplyProseProposal: h.autoApplyProseProposal,
}));
vi.mock("@/lib/debugLog", () => ({
  debugLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  errorDetail: (e: unknown) => e,
}));

import {
  setupAutoAcceptProseConsumer,
  drainProposedProse,
  resetAutoAcceptProseConsumerForTest,
} from "@/features/agent-writes/autoAcceptFeed";
import { useProseStagingStore } from "@/features/agent-writes/proseStagingStore";

function proposal(
  over: Partial<PendingProseProposal> = {},
): PendingProseProposal {
  return {
    stagingId: "stage-1",
    sceneId: "scene-1",
    text: "World",
    mode: "append",
    ...over,
  } as PendingProseProposal;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetAutoAcceptProseConsumerForTest();
  h.handler = null;
  h.state.toggleOn = false;
  h.state.bodyWriteOn = true;
  h.state.outcome = { applied: true };
  h.state.backlog = [];
  useProseStagingStore.getState().clear();
});

describe("auto-accept gate (live handler)", () => {
  it("registers a handler on setup", () => {
    setupAutoAcceptProseConsumer();
    expect(typeof h.handler).toBe("function");
  });

  it("does not apply when the opt-in toggle is off", async () => {
    h.state.toggleOn = false;
    setupAutoAcceptProseConsumer();
    const consumed = await h.handler!(proposal(), "proj-1");
    expect(consumed).toBe(false);
    expect(h.autoApplyProseProposal).not.toHaveBeenCalled();
  });

  it("does not apply when bodyWrite policy is off, even with the toggle on", async () => {
    h.state.toggleOn = true;
    h.state.bodyWriteOn = false;
    setupAutoAcceptProseConsumer();
    const consumed = await h.handler!(proposal(), "proj-1");
    expect(consumed).toBe(false);
    expect(h.autoApplyProseProposal).not.toHaveBeenCalled();
  });

  it("applies an append proposal when fully enabled", async () => {
    h.state.toggleOn = true;
    h.state.bodyWriteOn = true;
    setupAutoAcceptProseConsumer();
    const consumed = await h.handler!(proposal(), "proj-1");
    expect(consumed).toBe(true);
    expect(h.autoApplyProseProposal).toHaveBeenCalledTimes(1);
  });

  it("leaves non-anchored insert/replace for human review (not consumed, not applied)", async () => {
    h.state.toggleOn = true;
    setupAutoAcceptProseConsumer();
    for (const mode of ["insert", "replace"] as const) {
      const consumed = await h.handler!(proposal({ mode }), "proj-1");
      expect(consumed).toBe(false);
    }
    expect(h.autoApplyProseProposal).not.toHaveBeenCalled();
  });

  it("applies an anchored insert when fully enabled", async () => {
    h.state.toggleOn = true;
    setupAutoAcceptProseConsumer();
    const consumed = await h.handler!(
      proposal({ mode: "insert", anchorText: "somewhere" }),
      "proj-1",
    );
    expect(consumed).toBe(true);
    expect(h.autoApplyProseProposal).toHaveBeenCalledTimes(1);
  });
});

describe("backlog drain", () => {
  it("does nothing when disabled", async () => {
    h.state.toggleOn = false;
    await drainProposedProse("proj-1");
    expect(h.loadAllProposedProse).not.toHaveBeenCalled();
  });

  it("applies appendable backlog rows and skips the rest", async () => {
    h.state.toggleOn = true;
    h.state.backlog = [
      proposal({ stagingId: "s1", mode: "append" }),
      proposal({ stagingId: "s2", mode: "insert" }),
      proposal({ stagingId: "s3", mode: "append" }),
    ];
    await drainProposedProse("proj-1");
    expect(h.loadAllProposedProse).toHaveBeenCalledWith("proj-1");
    // only the two append rows reach autoApplyProseProposal
    expect(h.autoApplyProseProposal).toHaveBeenCalledTimes(2);
  });

  it("適用できなかった backlog 行は diff レビューへ enqueue する (live poller と同じ fallback)", async () => {
    h.state.toggleOn = true;
    h.state.backlog = [
      proposal({ stagingId: "s1", baseVersion: 1 }),
      proposal({ stagingId: "s2", baseVersion: 1 }),
    ];
    // 1 件目の適用が scene version を bump → 2 件目は stale でブロックされる
    // シナリオ。enqueue フォールバックが無いと s2 は「適用もされず diff にも
    // 出ない」サイレント孤児になる。
    h.autoApplyProseProposal.mockImplementation(async (p) =>
      p.stagingId === "s1"
        ? { applied: true }
        : { applied: false, reason: "stale-base-version" },
    );
    await drainProposedProse("proj-1");
    expect(h.autoApplyProseProposal).toHaveBeenCalledTimes(2);
    expect(useProseStagingStore.getState().pending?.stagingId).toBe("s2");
  });

  it("適用済みの backlog 行は enqueue しない", async () => {
    h.state.toggleOn = true;
    h.state.backlog = [proposal({ stagingId: "s1" })];
    await drainProposedProse("proj-1");
    expect(useProseStagingStore.getState().pending).toBeNull();
  });
});
