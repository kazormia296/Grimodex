// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockBlock, mockFindBeatById } = vi.hoisted(() => ({
  mockBlock: vi.fn(() => false),
  mockFindBeatById: vi.fn(() => null),
}));

vi.mock("@/features/ai-policy/policyGuard", () => ({
  blockIfPolicyOff: mockBlock,
}));
vi.mock("./insertBeatStream", () => ({
  findBeatById: mockFindBeatById,
  appendBeatChunk: vi.fn(),
  ensureGeneratedBlock: vi.fn(),
}));
vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: { getState: () => ({ nodes: [] }) },
}));
vi.mock("@/features/settings/settingsStore", () => ({
  useSettingsStore: { getState: () => ({}) },
}));
vi.mock("@/features/workspace/store", () => ({
  useWorkspaceStore: { getState: () => ({ activeWorkspaceName: "" }) },
}));
vi.mock("@/features/project/api", () => ({ getProject: vi.fn() }));
vi.mock("@/features/codex/codexStore", () => ({
  useCodexStore: { getState: () => ({}) },
}));
vi.mock("@/features/editor/inlineAi/inlineAiStreaming", () => ({
  sendInlineAiStream: vi.fn(),
}));
vi.mock("@/features/attribution/generationLogApi", () => ({
  insertGenerationLog: vi.fn(),
}));
vi.mock("./beatPromptBuilder", () => ({ buildBeatMessages: vi.fn() }));

import { generateBeatOnce } from "./generateBeatOnce";

const fakeEditor = {
  state: { doc: { nodeAt: () => null } },
} as unknown as Parameters<typeof generateBeatOnce>[0];

describe("generateBeatOnce — bodyWrite gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBlock.mockReturnValue(false);
    mockFindBeatById.mockReturnValue(null);
  });

  it("bodyWrite=off なら editor に触れず即 return", async () => {
    mockBlock.mockReturnValue(true);
    await generateBeatOnce(fakeEditor, "b1", "s1");
    expect(mockFindBeatById).not.toHaveBeenCalled();
  });

  it("許可時は beat 探索へ進む (gate を通過する)", async () => {
    mockBlock.mockReturnValue(false);
    await generateBeatOnce(fakeEditor, "b1", "s1");
    expect(mockFindBeatById).toHaveBeenCalledWith(fakeEditor, "b1");
  });
});
