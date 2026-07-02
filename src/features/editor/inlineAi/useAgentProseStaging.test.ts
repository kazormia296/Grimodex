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
  stale: false,
  proposal: null as PendingProseProposal | null,
  enqueue: vi.fn(),
  clear: vi.fn(),
  loadLatestProposedProse: vi.fn(async () => h.proposal),
  isAutoAcceptEnabled: vi.fn(async () => h.enabled),
  isProposalStale: vi.fn(async () => h.stale),
  agentAcceptProseStage: vi.fn(async () => ({})),
  agentDiscardProseStage: vi.fn(async () => ({})),
  saveScene: vi.fn(async () => {}),
  toastInfo: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/features/agent-writes/proseStagingStore", () => ({
  useProseStagingStore: (selector: (s: unknown) => unknown) =>
    selector({ pending: null, clear: h.clear, enqueue: h.enqueue }),
}));
vi.mock("@/features/agent-writes/prose", () => ({
  loadLatestProposedProse: h.loadLatestProposedProse,
  agentAcceptProseStage: h.agentAcceptProseStage,
  agentDiscardProseStage: h.agentDiscardProseStage,
}));
vi.mock("sonner", () => ({
  toast: { info: h.toastInfo, error: h.toastError },
}));
vi.mock("@/lib/i18n", () => ({
  default: { t: (k: string) => k },
}));
vi.mock("@/features/editor/editorSaveRegistry", () => ({
  saveScene: h.saveScene,
}));
vi.mock("@/features/agent-writes/autoAcceptGate", () => ({
  isAutoAcceptEnabled: h.isAutoAcceptEnabled,
  isHeadlessAppliable: (p: { mode: string; anchorText?: string }) =>
    p.mode === "append" || (p.mode === "insert" && !!p.anchorText),
  isProposalStale: h.isProposalStale,
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
  h.stale = false;
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

  it("stale (base_version 不一致) な append proposal は auto-accept ON でも surface する", async () => {
    // headless 自動適用 (autoApplyProse) は stale 行を適用せず `proposed` の
    // まま残す。「auto-apply が拾うから隠す」suppression の前提が成り立たない
    // ので、隠すと「適用もされず diff にも出ない」永久孤児になる。
    h.enabled = true;
    h.stale = true;
    h.proposal = {
      stagingId: "s1",
      sceneId: "scene-1",
      text: "x",
      mode: "append",
      baseVersion: 1,
    };
    renderHook(() => useAgentProseStaging(null, "scene-1", diffApi));
    await waitFor(() => expect(h.enqueue).toHaveBeenCalledTimes(1));
    expect(h.enqueue).toHaveBeenCalledWith(h.proposal);
  });

  it("fresh (base_version 一致) な append proposal は従来通り suppress する", async () => {
    h.enabled = true;
    h.stale = false;
    h.proposal = {
      stagingId: "s1",
      sceneId: "scene-1",
      text: "x",
      mode: "append",
      baseVersion: 1,
    };
    renderHook(() => useAgentProseStaging(null, "scene-1", diffApi));
    await waitFor(() => expect(h.isProposalStale).toHaveBeenCalled());
    await flush();
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it("stale 判定が reject しても crash せず suppress 継続に倒す (M-1)", async () => {
    // isProposalStale の失敗 (DB エラー等) は「非 stale = suppression 継続」。
    // 誤って enqueue すると適用済み内容の幽霊 diff (I-1) と同型事故になる。
    h.enabled = true;
    h.proposal = {
      stagingId: "s1",
      sceneId: "scene-1",
      text: "x",
      mode: "append",
      baseVersion: 1,
    };
    h.isProposalStale.mockRejectedValueOnce(new Error("db read failed"));
    renderHook(() => useAgentProseStaging(null, "scene-1", diffApi));
    await waitFor(() => expect(h.isProposalStale).toHaveBeenCalled());
    await flush();
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it("enqueue 直前の status 再読: 再読で proposed でなくなっていたら乗せない (I-1a)", async () => {
    // mount の観測 → suppression 判定 (IPC await) の隙に drain/poller が適用
    // すると、初回観測時 proposed だった行が accepted になっている。再読で
    // 消えていたら enqueue しない (適用済み内容の幽霊 diff 防止)。
    h.enabled = false; // suppression 無し = 素通しで enqueue しようとする経路
    const p1 = {
      stagingId: "s1",
      sceneId: "scene-1",
      text: "x",
      mode: "append",
    } as PendingProseProposal;
    h.loadLatestProposedProse
      .mockResolvedValueOnce(p1) // 初回観測: proposed
      .mockResolvedValueOnce(null); // 再読: もう proposed ではない
    renderHook(() => useAgentProseStaging(null, "scene-1", diffApi));
    await waitFor(() =>
      expect(h.loadLatestProposedProse).toHaveBeenCalledTimes(2),
    );
    await flush();
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it("再読が別の stagingId を返したら (行が入れ替わった) 乗せない (I-1a)", async () => {
    // 入れ替わった行の suppression / stale 判定はまだしていないので
    // enqueue しない。新しい行は次の mount / accept 後チェーンが改めて
    // 判定して拾う。
    h.enabled = false;
    const p1 = {
      stagingId: "s1",
      sceneId: "scene-1",
      text: "x",
      mode: "append",
    } as PendingProseProposal;
    const p2 = { ...p1, stagingId: "s2" };
    h.loadLatestProposedProse
      .mockResolvedValueOnce(p1)
      .mockResolvedValueOnce(p2);
    renderHook(() => useAgentProseStaging(null, "scene-1", diffApi));
    await waitFor(() =>
      expect(h.loadLatestProposedProse).toHaveBeenCalledTimes(2),
    );
    await flush();
    expect(h.enqueue).not.toHaveBeenCalled();
  });
});

describe("useAgentProseStaging — accept/reject の staging 連携", () => {
  it("accept が not-in-proposed で失敗したら幽霊 diff を破棄する (I-1b backstop)", async () => {
    const api = { ...diffApi, getActiveStagingId: () => "s1" };
    h.agentAcceptProseStage.mockRejectedValueOnce(
      new Error("staging entry is not in proposed status"),
    );
    const { result } = renderHook(() =>
      useAgentProseStaging(null, "scene-1", api),
    );
    await result.current.acceptWithStaging();
    // 適用はしない (行は別経路で処理済み = この diff は幽霊)
    expect(api.accept).not.toHaveBeenCalled();
    // 張り付かせず破棄 + 軽い通知
    expect(api.rejectOrAbort).toHaveBeenCalledTimes(1);
    expect(h.toastInfo).toHaveBeenCalledTimes(1);
  });

  it("not-in-proposed 以外の accept 失敗は従来通り diff を残す (リトライ可能)", async () => {
    const api = { ...diffApi, getActiveStagingId: () => "s1" };
    h.agentAcceptProseStage.mockRejectedValueOnce(new Error("db locked"));
    const { result } = renderHook(() =>
      useAgentProseStaging(null, "scene-1", api),
    );
    await result.current.acceptWithStaging();
    expect(api.accept).not.toHaveBeenCalled();
    expect(api.rejectOrAbort).not.toHaveBeenCalled();
    expect(h.toastInfo).not.toHaveBeenCalled();
  });

  it("accept 完了後、同一シーンの次の proposed 行をチェーンで surface する (I-3)", async () => {
    h.proposal = null; // mount 時は何も無い
    const api = { ...diffApi, getActiveStagingId: () => "s1" };
    const { result } = renderHook(() =>
      useAgentProseStaging(null, "scene-1", api),
    );
    await flush();
    // accept された行の後ろに、blocked のままの2件目が残っているシナリオ
    // (単一スロット pending は1件しか保持できない — I-3)
    const p2 = {
      stagingId: "s2",
      sceneId: "scene-1",
      text: "y",
      mode: "append",
    } as PendingProseProposal;
    h.proposal = p2;
    await result.current.acceptWithStaging();
    expect(h.agentAcceptProseStage).toHaveBeenCalledWith("s1");
    expect(api.accept).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(h.enqueue).toHaveBeenCalledWith(p2));
  });

  it("reject 完了後も次の proposed 行をチェーンで surface する (I-3)", async () => {
    h.proposal = null;
    const api = { ...diffApi, getActiveStagingId: () => "s1" };
    const { result } = renderHook(() =>
      useAgentProseStaging(null, "scene-1", api),
    );
    await flush();
    const p2 = {
      stagingId: "s2",
      sceneId: "scene-1",
      text: "y",
      mode: "append",
    } as PendingProseProposal;
    h.proposal = p2;
    await result.current.rejectWithStaging();
    expect(h.agentDiscardProseStage).toHaveBeenCalledWith("s1");
    expect(api.rejectOrAbort).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(h.enqueue).toHaveBeenCalledWith(p2));
  });

  it("チェーンは accept 内容の保存 (saveScene) 完了後に次行を読む (I-2b)", async () => {
    // accept は autosave を arm するだけで永続化はまだ。P1 未保存のまま
    // P2 プレビュー (実テキスト挿入) が doc に乗ると、armed タイマーの発火で
    // プレビュー込み doc が焼き込まれる。チェーンは dirty-gated flush
    // (saveScene) で accept 内容を確定させてから次行を surface する。
    h.proposal = null;
    const api = { ...diffApi, getActiveStagingId: () => "s1" };
    const { result } = renderHook(() =>
      useAgentProseStaging(null, "scene-1", api),
    );
    await flush();
    const order: string[] = [];
    h.saveScene.mockImplementationOnce(async () => {
      order.push("saveScene");
    });
    h.loadLatestProposedProse.mockImplementationOnce(async () => {
      order.push("load");
      return null;
    });
    await result.current.acceptWithStaging();
    await waitFor(() => expect(order).toContain("load"));
    expect(order).toEqual(["saveScene", "load"]);
    expect(h.saveScene).toHaveBeenCalledWith("scene-1");
  });
});
