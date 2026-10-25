// @vitest-environment happy-dom
//
// DA-2b の PUB-G 前の必須 3（DR-DA2B-R22）：外部送信の制限で AI の入口が閉じている間、
// `useAiGate` は見える control を理由つきの disabled にする。policy の hidden は hidden の
// まま、capability（policy の判定の正本）は変えない。chat の送信（呼出し側が閉鎖を扱う）
// は上書きしない。定数が false の間は閉の状態があっても今のまま。
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const flags = vi.hoisted(() => ({ enabled: true }));

vi.mock("@/features/profile-egress/profileActivationAvailability", () => ({
  get PROFILE_ACTIVATION_UI_ENABLED() {
    return flags.enabled;
  },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

import { useAiGate } from "./useAiGate";
import { useProjectStore } from "@/features/project/projectStore";
import { useAiSettingsStore } from "@/features/chat/store";
import type { AiPolicyToggles } from "./types";

const ALL_ON: AiPolicyToggles = {
  chat: true,
  bodyWrite: true,
  analysis: true,
  structureWrite: true,
  knowledgeWrite: true,
};

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

function closeEntrances() {
  useAiSettingsStore.setState({ profileEgressClosed: true });
}

beforeEach(() => {
  flags.enabled = true;
  useAiSettingsStore.setState({ profileEgressClosed: undefined });
  setProviderReady(true);
  setPolicy(ALL_ON);
});

describe("useAiGate の外部送信の制限の上書き（定数 true）", () => {
  it.each(["bodyWrite", "analysis", "chat"] as const)(
    "%s：閉になると remount なしで理由つきの disabled になる",
    (feature) => {
      const { result } = renderHook(() => useAiGate(feature));
      expect(result.current.presentation).toBe("enabled");

      act(() => closeEntrances());

      expect(result.current.presentation).toBe("disabled");
      expect(result.current.tooltip).toBe("profileEgress.ai.closed");
      // The policy decision itself is unchanged.
      expect(result.current.capability).toEqual({ state: "enabled" });
    },
  );

  it("provider の未設定の disabled も理由を制限の文にする", () => {
    setProviderReady(false);
    closeEntrances();
    const { result } = renderHook(() => useAiGate("analysis"));
    expect(result.current.presentation).toBe("disabled");
    expect(result.current.tooltip).toBe("profileEgress.ai.closed");
    expect(result.current.capability).toEqual({
      state: "disabled",
      reason: "no-provider",
    });
  });

  it("policy の hidden は hidden のまま", () => {
    setPolicy({ ...ALL_ON, analysis: false });
    closeEntrances();
    const { result } = renderHook(() => useAiGate("analysis"));
    expect(result.current.presentation).toBe("hidden");
    expect(result.current.tooltip).toBeNull();
  });

  it("閉鎖を呼出し側が扱う chat の送信は上書きしない", () => {
    closeEntrances();
    const { result } = renderHook(() => useAiGate("chat-send"));
    expect(result.current.presentation).toBe("enabled");
    expect(result.current.tooltip).toBeNull();
  });

  it("開なら今のまま", () => {
    const { result } = renderHook(() => useAiGate("bodyWrite"));
    expect(result.current.presentation).toBe("enabled");
    expect(result.current.tooltip).toBeNull();
  });
});

describe("定数が false の間（今の製品）", () => {
  it("閉の状態があっても上書きしない", () => {
    flags.enabled = false;
    closeEntrances();
    const { result } = renderHook(() => useAiGate("bodyWrite"));
    expect(result.current.presentation).toBe("enabled");
    expect(result.current.tooltip).toBeNull();
  });
});
