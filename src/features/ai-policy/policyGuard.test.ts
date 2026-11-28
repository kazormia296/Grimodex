// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRefreshMissingProject = vi.hoisted(() => vi.fn());

vi.mock("./refreshMissingProject", () => ({
  refreshProjectListOnceIfCurrentMissing: mockRefreshMissingProject,
}));

vi.mock("@/features/project/projectStore", () => ({
  useProjectStore: { getState: vi.fn() },
  getCurrentProjectId: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("@/lib/i18n", () => ({ default: { t: (key: string) => key } }));

import {
  useProjectStore,
  getCurrentProjectId,
} from "@/features/project/projectStore";
import { toast } from "sonner";
import {
  getAiFeatureBlockReason,
  isAiFeatureBlockedByPolicy,
  blockIfPolicyOff,
} from "./policyGuard";
import { serializeAiPolicy } from "./parse";
import type { AiPolicy } from "./types";

const mockGetState = vi.mocked(useProjectStore.getState);
const mockGetCurrentProjectId = vi.mocked(getCurrentProjectId);
const mockToastError = vi.mocked(toast.error);

function setProjectRawPolicy(raw: string | null) {
  mockGetCurrentProjectId.mockReturnValue("p1");
  const projects = raw === null ? [] : [{ id: "p1", aiPolicy: raw }];
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

describe("AI policy block reasons", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setProjectRawPolicy(serializeAiPolicy(policyOf({ bodyWrite: false })));
  });

  it("uses policy for an explicitly disabled valid feature", () => {
    expect(getAiFeatureBlockReason("bodyWrite")).toBe("policy");
    expect(isAiFeatureBlockedByPolicy("bodyWrite")).toBe(true);
  });

  it("blocks only write axes when the current Project is unavailable", () => {
    setProjectRawPolicy(null);
    for (const feature of [
      "bodyWrite",
      "structureWrite",
      "knowledgeWrite",
    ] as const) {
      expect(getAiFeatureBlockReason(feature)).toBe("unavailable");
    }
    expect(getAiFeatureBlockReason("chat")).toBeNull();
    expect(getAiFeatureBlockReason("analysis")).toBeNull();
    expect(mockRefreshMissingProject).toHaveBeenCalled();
  });

  it("blocks only write axes for an invalid policy and preserves readable chat/analysis", () => {
    setProjectRawPolicy("not-json");
    for (const feature of [
      "bodyWrite",
      "structureWrite",
      "knowledgeWrite",
    ] as const) {
      expect(getAiFeatureBlockReason(feature)).toBe("invalid");
    }
    expect(getAiFeatureBlockReason("chat")).toBeNull();
    expect(getAiFeatureBlockReason("analysis")).toBeNull();
  });

  it("uses policy for readable false chat and analysis even in an invalid record", () => {
    setProjectRawPolicy(
      '{"preset":"full","toggles":{"chat":false,"bodyWrite":1,"analysis":false}}',
    );
    expect(getAiFeatureBlockReason("chat")).toBe("policy");
    expect(getAiFeatureBlockReason("analysis")).toBe("policy");
    expect(getAiFeatureBlockReason("bodyWrite")).toBe("invalid");
  });
});

describe("blockIfPolicyOff", () => {
  beforeEach(() => vi.clearAllMocks());

  it("keeps the existing policy toast", () => {
    setProjectRawPolicy(serializeAiPolicy(policyOf({ chat: false })));
    expect(blockIfPolicyOff("chat")).toBe(true);
    expect(mockToastError).toHaveBeenCalledWith(
      "aiPolicy.disabledReason.policy",
    );
  });

  it("uses the invalid-policy toast", () => {
    setProjectRawPolicy("not-json");
    expect(blockIfPolicyOff("bodyWrite")).toBe(true);
    expect(mockToastError).toHaveBeenCalledWith(
      "aiPolicy.disabledReason.invalidPolicy",
    );
  });

  it("uses the unavailable-project toast", () => {
    setProjectRawPolicy(null);
    expect(blockIfPolicyOff("bodyWrite")).toBe(true);
    expect(mockToastError).toHaveBeenCalledWith(
      "aiPolicy.disabledReason.projectUnavailable",
    );
  });

  it("does not toast when allowed", () => {
    setProjectRawPolicy(serializeAiPolicy(policyOf({ chat: true })));
    expect(blockIfPolicyOff("chat")).toBe(false);
    expect(mockToastError).not.toHaveBeenCalled();
  });
});

describe("new-project default backstop (security F-6)", () => {
  beforeEach(() => vi.clearAllMocks());

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
    setProjectRawPolicy(serializeAiPolicy(newProjectDefault()));
    expect(isAiFeatureBlockedByPolicy("knowledgeWrite")).toBe(true);
    expect(isAiFeatureBlockedByPolicy("structureWrite")).toBe(true);
  });

  it("still allows chat / analysis / bodyWrite by default", () => {
    setProjectRawPolicy(serializeAiPolicy(newProjectDefault()));
    expect(isAiFeatureBlockedByPolicy("chat")).toBe(false);
    expect(isAiFeatureBlockedByPolicy("analysis")).toBe(false);
    expect(isAiFeatureBlockedByPolicy("bodyWrite")).toBe(false);
  });
});
