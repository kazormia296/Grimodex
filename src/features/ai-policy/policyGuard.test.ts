// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/features/project/projectStore", () => ({
  useProjectStore: { getState: vi.fn() },
  getCurrentProjectId: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("@/lib/i18n", () => ({ default: { t: (k: string) => k } }));

import {
  useProjectStore,
  getCurrentProjectId,
} from "@/features/project/projectStore";
import { toast } from "sonner";
import { isAiFeatureBlockedByPolicy, blockIfPolicyOff } from "./policyGuard";
import { serializeAiPolicy } from "./parse";
import type { AiPolicy } from "./types";

const mockGetState = vi.mocked(useProjectStore.getState);
const mockGetCurrentProjectId = vi.mocked(getCurrentProjectId);
const mockToastError = vi.mocked(toast.error);

function setProjectPolicy(policy: AiPolicy | null) {
  mockGetCurrentProjectId.mockReturnValue("p1");
  const projects =
    policy === null ? [] : [{ id: "p1", aiPolicy: serializeAiPolicy(policy) }];
  // policyGuard だけが触る形だけ満たせばよい（projects のみ）。
  mockGetState.mockReturnValue({ projects } as never);
}

function policyOf(toggles: Partial<AiPolicy["toggles"]>): AiPolicy {
  return {
    preset: "custom",
    toggles: {
      chat: true,
      bodyWrite: true,
      analysis: true,
      structureWrite: true,
      knowledgeWrite: true,
      ...toggles,
    },
  };
}

describe("isAiFeatureBlockedByPolicy", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns true when the feature toggle is off", () => {
    setProjectPolicy(policyOf({ bodyWrite: false }));
    expect(isAiFeatureBlockedByPolicy("bodyWrite")).toBe(true);
  });

  it("returns false when the feature toggle is on", () => {
    setProjectPolicy(policyOf({ bodyWrite: true }));
    expect(isAiFeatureBlockedByPolicy("bodyWrite")).toBe(false);
  });

  it("is independent per feature", () => {
    setProjectPolicy(policyOf({ chat: false, bodyWrite: true }));
    expect(isAiFeatureBlockedByPolicy("chat")).toBe(true);
    expect(isAiFeatureBlockedByPolicy("bodyWrite")).toBe(false);
  });

  it("fails open (allows) when the project is missing from the cache", () => {
    // 破損/未ロード時は DEFAULT(full) に倒れる ＝ ブロックしない。
    setProjectPolicy(null);
    expect(isAiFeatureBlockedByPolicy("chat")).toBe(false);
    expect(isAiFeatureBlockedByPolicy("bodyWrite")).toBe(false);
    expect(isAiFeatureBlockedByPolicy("analysis")).toBe(false);
  });
});

describe("blockIfPolicyOff", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns true and toasts the policy reason when blocked", () => {
    setProjectPolicy(policyOf({ chat: false }));
    expect(blockIfPolicyOff("chat")).toBe(true);
    expect(mockToastError).toHaveBeenCalledWith(
      "aiPolicy.disabledReason.policy",
    );
  });

  it("returns false and does not toast when allowed", () => {
    setProjectPolicy(policyOf({ chat: true }));
    expect(blockIfPolicyOff("chat")).toBe(false);
    expect(mockToastError).not.toHaveBeenCalled();
  });
});

describe("new-project default backstop (security F-6)", () => {
  beforeEach(() => vi.clearAllMocks());

  // schema.ts / migrate.rs の新規デフォルトと同じトグルセット。
  const newProjectDefault = (): AiPolicy => ({
    preset: "custom",
    toggles: {
      chat: true,
      bodyWrite: true,
      analysis: true,
      structureWrite: false,
      knowledgeWrite: false,
    },
  });

  it("blocks autonomous knowledge/structure writes by default", () => {
    setProjectPolicy(newProjectDefault());
    expect(isAiFeatureBlockedByPolicy("knowledgeWrite")).toBe(true);
    expect(isAiFeatureBlockedByPolicy("structureWrite")).toBe(true);
  });

  it("still allows chat / analysis / bodyWrite by default", () => {
    setProjectPolicy(newProjectDefault());
    expect(isAiFeatureBlockedByPolicy("chat")).toBe(false);
    expect(isAiFeatureBlockedByPolicy("analysis")).toBe(false);
    expect(isAiFeatureBlockedByPolicy("bodyWrite")).toBe(false);
  });
});
