// @vitest-environment happy-dom
//
// 統合テスト: useAiGate を **モックせず実コードのまま** 実ストア
// (useProjectStore / useAiSettingsStore) に配線し、
//   projectStore 変更 → useCurrentProject → useCurrentProjectAiPolicy
//   → evaluateAiCapability → deriveAiGate → presentation
// のリアクティブな鎖が remount なしで追従することを検証する。
// (updateField → refreshProjects の DB 書き込み経路は Tauri 依存のため対象外。
//  ここで検証するのは store 更新 → 表示方針の React 反応性。)
import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

import { useAiGate } from "./useAiGate";
import { useProjectStore } from "@/features/project/projectStore";
import { useAiSettingsStore } from "@/features/chat/store";
import type { AiPolicyToggles } from "./types";

function setPolicy(toggles: AiPolicyToggles) {
  useProjectStore.setState({
    currentProjectId: "p1",
    projects: [
      { id: "p1", aiPolicy: JSON.stringify({ preset: "custom", toggles }) },
    ] as never,
  });
}

function setProviderReady(ready: boolean) {
  useAiSettingsStore.setState({
    settings: { provider: "anthropic", model: "claude-x" },
    hasApiKey: ready,
  } as never);
}

const ALL_ON: AiPolicyToggles = { chat: true, bodyWrite: true, analysis: true };

describe("useAiGate live chain (projectStore → presentation)", () => {
  beforeEach(() => {
    setProviderReady(true);
    setPolicy(ALL_ON);
  });

  it("reacts to a policy toggle without remount: enabled → hidden → enabled", () => {
    const { result } = renderHook(() => useAiGate("chat"));
    expect(result.current.presentation).toBe("enabled");

    act(() => setPolicy({ chat: false, bodyWrite: true, analysis: true }));
    expect(result.current.presentation).toBe("hidden");

    act(() => setPolicy(ALL_ON));
    expect(result.current.presentation).toBe("enabled");
  });

  it("no-provider with policy ON → disabled (visible), NOT hidden (reason-split)", () => {
    setPolicy(ALL_ON);
    setProviderReady(false);
    const { result } = renderHook(() => useAiGate("chat"));
    expect(result.current.presentation).toBe("disabled");
    expect(result.current.capability).toEqual({
      state: "disabled",
      reason: "no-provider",
    });
  });

  it("per-feature independence: bodyWrite OFF hides bodyWrite, leaves analysis enabled", () => {
    setPolicy({ chat: true, bodyWrite: false, analysis: true });
    const { result: bodyWrite } = renderHook(() => useAiGate("bodyWrite"));
    const { result: analysis } = renderHook(() => useAiGate("analysis"));
    expect(bodyWrite.current.presentation).toBe("hidden");
    expect(analysis.current.presentation).toBe("enabled");
  });
});
