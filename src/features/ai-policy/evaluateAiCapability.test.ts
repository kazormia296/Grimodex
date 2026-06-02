import { describe, it, expect } from "vitest";
import { evaluateAiCapability, deriveAiGate } from "./evaluateAiCapability";
import type { ProviderReadiness } from "@/features/chat/store";
import type { AiCapability, AiFeature, AiPolicy } from "./types";

function policyOf(toggles: Partial<AiPolicy["toggles"]> = {}): AiPolicy {
  return {
    preset: "custom",
    toggles: { chat: true, bodyWrite: true, analysis: true, ...toggles },
  };
}

const FEATURES: AiFeature[] = ["chat", "bodyWrite", "analysis"];

describe("evaluateAiCapability", () => {
  it("returns pending when policy is null (project not loaded)", () => {
    for (const f of FEATURES) {
      expect(evaluateAiCapability(null, "ready", f)).toEqual({
        state: "pending",
      });
    }
  });

  it("returns pending when readiness is pending (even with policy on)", () => {
    expect(evaluateAiCapability(policyOf(), "pending", "chat")).toEqual({
      state: "pending",
    });
  });

  it("returns enabled when policy allows and provider is ready", () => {
    for (const f of FEATURES) {
      expect(evaluateAiCapability(policyOf(), "ready", f)).toEqual({
        state: "enabled",
      });
    }
  });

  it("returns policy-disabled when the feature toggle is off", () => {
    expect(
      evaluateAiCapability(
        policyOf({ bodyWrite: false }),
        "ready",
        "bodyWrite",
      ),
    ).toEqual({ state: "disabled", reason: "policy" });
    // 他の feature は影響を受けない
    expect(
      evaluateAiCapability(policyOf({ bodyWrite: false }), "ready", "chat"),
    ).toEqual({ state: "enabled" });
  });

  it("returns no-model when readiness is no-model and policy allows", () => {
    expect(evaluateAiCapability(policyOf(), "no-model", "chat")).toEqual({
      state: "disabled",
      reason: "no-model",
    });
  });

  it("returns no-provider when readiness is no-provider and policy allows", () => {
    expect(evaluateAiCapability(policyOf(), "no-provider", "analysis")).toEqual(
      {
        state: "disabled",
        reason: "no-provider",
      },
    );
  });

  it("policy outranks no-model and no-provider", () => {
    expect(
      evaluateAiCapability(policyOf({ chat: false }), "no-provider", "chat"),
    ).toEqual({ state: "disabled", reason: "policy" });
    expect(
      evaluateAiCapability(policyOf({ chat: false }), "no-model", "chat"),
    ).toEqual({ state: "disabled", reason: "policy" });
  });

  it("no-model outranks no-provider (readiness selector already encodes order)", () => {
    expect(evaluateAiCapability(policyOf(), "no-model", "chat")).toEqual({
      state: "disabled",
      reason: "no-model",
    });
  });

  it("pending (null policy) outranks a would-be policy disable", () => {
    // policy 未ロード中は機能を弾く判定を出さない（pending）。
    const r: ProviderReadiness = "ready";
    expect(evaluateAiCapability(null, r, "chat")).toEqual({ state: "pending" });
  });
});

describe("deriveAiGate", () => {
  it("enabled -> presentation enabled, no tooltip", () => {
    expect(deriveAiGate({ state: "enabled" })).toEqual({
      presentation: "enabled",
      tooltipKey: null,
    });
  });

  it("pending -> presentation pending (not hidden), no tooltip", () => {
    expect(deriveAiGate({ state: "pending" })).toEqual({
      presentation: "pending",
      tooltipKey: null,
    });
  });

  it("disabled by policy -> hidden, no tooltip", () => {
    const cap: AiCapability = { state: "disabled", reason: "policy" };
    expect(deriveAiGate(cap)).toEqual({
      presentation: "hidden",
      tooltipKey: null,
    });
  });

  it("disabled by no-model -> disabled (visible) + tooltip key", () => {
    const cap: AiCapability = { state: "disabled", reason: "no-model" };
    expect(deriveAiGate(cap)).toEqual({
      presentation: "disabled",
      tooltipKey: "aiPolicy.disabledReason.noModel",
    });
  });

  it("disabled by no-provider -> disabled (visible) + tooltip key", () => {
    const cap: AiCapability = { state: "disabled", reason: "no-provider" };
    expect(deriveAiGate(cap)).toEqual({
      presentation: "disabled",
      tooltipKey: "aiPolicy.disabledReason.noProvider",
    });
  });

  it("only policy is hidden; provider/model stay visible-disabled", () => {
    // 合意済み方針の回帰: hide は policy 限定。
    expect(
      deriveAiGate({ state: "disabled", reason: "policy" }).presentation,
    ).toBe("hidden");
    expect(
      deriveAiGate({ state: "disabled", reason: "no-model" }).presentation,
    ).toBe("disabled");
    expect(
      deriveAiGate({ state: "disabled", reason: "no-provider" }).presentation,
    ).toBe("disabled");
  });
});
