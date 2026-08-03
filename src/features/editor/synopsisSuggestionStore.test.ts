// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockBlockIfPolicyOff,
  mockIsBlocked,
  mockUpdateSynopsis,
  mockGenerate,
  mockLoadScene,
} = vi.hoisted(() => ({
  mockBlockIfPolicyOff: vi.fn(() => false),
  mockIsBlocked: vi.fn(() => false),
  mockUpdateSynopsis: vi.fn().mockResolvedValue(undefined),
  mockGenerate: vi.fn().mockResolvedValue("生成あらすじ"),
  mockLoadScene: vi.fn().mockResolvedValue({ type: "doc" }),
}));

vi.mock("@/features/ai-policy/policyGuard", () => ({
  blockIfPolicyOff: mockBlockIfPolicyOff,
  isAiFeatureBlockedByPolicy: mockIsBlocked,
}));
vi.mock("@/features/tree/treeProjection", () => ({
  findTreeNodeSummary: (id: string) =>
    id === "s1" ? { id: "s1", title: "T", nodeType: "scene" } : null,
  updateTreeSynopsis: mockUpdateSynopsis,
}));
vi.mock("@/features/tree/api", () => ({ loadSceneContent: mockLoadScene }));
vi.mock("@/features/chat/chatApi", () => ({
  generateSynopsisFromContent: mockGenerate,
}));
vi.mock("@/lib/prosemirror", () => ({
  prosemirrorToText: () => "本文テキスト",
}));
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    dismiss: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  }),
}));
vi.mock("i18next", () => ({ default: { t: (k: string) => k } }));

import { useSynopsisSuggestionStore } from "./synopsisSuggestionStore";

beforeEach(() => {
  vi.clearAllMocks();
  mockBlockIfPolicyOff.mockReturnValue(false);
  mockIsBlocked.mockReturnValue(false);
  useSynopsisSuggestionStore.setState({ pendingSceneId: null });
});

describe("synopsisSuggestionStore — bodyWrite gate", () => {
  it("propose: bodyWrite=off なら提案を出さない (pendingSceneId 据え置き)", () => {
    mockIsBlocked.mockReturnValue(true);
    useSynopsisSuggestionStore.getState().propose("s1");
    expect(useSynopsisSuggestionStore.getState().pendingSceneId).toBeNull();
  });

  it("propose: 許可時は pendingSceneId をセット", () => {
    mockIsBlocked.mockReturnValue(false);
    useSynopsisSuggestionStore.getState().propose("s1");
    expect(useSynopsisSuggestionStore.getState().pendingSceneId).toBe("s1");
  });

  it("generate: bodyWrite=off なら生成を呼ばず即 return", async () => {
    mockBlockIfPolicyOff.mockReturnValue(true);
    useSynopsisSuggestionStore.setState({ pendingSceneId: "s1" });
    await useSynopsisSuggestionStore.getState().generate();
    expect(mockGenerate).not.toHaveBeenCalled();
    expect(mockUpdateSynopsis).not.toHaveBeenCalled();
  });

  it("generate: 許可時は生成して updateSynopsis を呼ぶ", async () => {
    mockBlockIfPolicyOff.mockReturnValue(false);
    useSynopsisSuggestionStore.setState({ pendingSceneId: "s1" });
    await useSynopsisSuggestionStore.getState().generate();
    expect(mockGenerate).toHaveBeenCalled();
    expect(mockUpdateSynopsis).toHaveBeenCalledWith("s1", "生成あらすじ");
  });
});
