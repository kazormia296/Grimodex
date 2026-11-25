import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  policy: vi.fn(),
  enabled: vi.fn(),
  count: vi.fn(),
  syncProject: vi.fn(),
}));

vi.mock(
  "@/features/narrative-extraction/runtime/narrativeRuntimePolicyApi",
  () => ({
    getNarrativeRuntimePolicy: mocks.policy,
  }),
);
vi.mock("@/features/narrative-extraction/maintenance/maintenanceFlags", () => ({
  isNarrativeMaintenanceUiEnabled: mocks.enabled,
}));
vi.mock("@/application/narrative-extraction/nativeApi", () => ({
  narrativeMaintenanceStaleProposalCount: mocks.count,
}));
vi.mock("@/features/codex/codexCandidateHostStore", () => ({
  useCodexCandidateHostStore: {
    getState: () => ({ projectId: null, syncProject: mocks.syncProject }),
    subscribe: () => () => {},
  },
  selectCodexCandidateCount: () => ({ status: "not-counted" }),
}));
vi.mock("@/features/codex/codexStore", () => ({
  useCodexStore: {
    getState: () => ({ entries: [] }),
    subscribe: () => () => {},
  },
}));
vi.mock("@/features/codex/codexStructureExtractionFlag", () => ({
  isCodexStructureExtractionReviewEnabled: () => false,
}));
vi.mock("@/features/project/projectStore", () => ({
  getCurrentProjectLanguage: () => "ja",
}));
vi.mock("@/features/ime/language", () => ({
  isJapaneseProjectLanguage: () => true,
}));

import { createWorkLayerLiveReaders } from "./workLayerLiveReaders";

describe("createWorkLayerLiveReaders: readStaleProposalCount", () => {
  beforeEach(() => {
    mocks.policy.mockReset().mockResolvedValue({});
    mocks.enabled.mockReset().mockReturnValue(true);
    mocks.count.mockReset();
    mocks.syncProject.mockReset();
  });

  it("reads only the count (never the whole Inbox) for the project", async () => {
    mocks.count.mockResolvedValue(7);
    const readers = createWorkLayerLiveReaders("p1");

    await expect(readers.readStaleProposalCount()).resolves.toEqual({
      allowed: true,
      count: 7,
    });
    expect(mocks.count).toHaveBeenCalledTimes(1);
    expect(mocks.count).toHaveBeenCalledWith({ projectId: "p1" });
  });

  it("does not read the count when maintenance is not allowed", async () => {
    mocks.enabled.mockReturnValue(false);
    const readers = createWorkLayerLiveReaders("p1");

    await expect(readers.readStaleProposalCount()).resolves.toEqual({
      allowed: false,
    });
    expect(mocks.count).not.toHaveBeenCalled();
  });

  it("lets a failed read reject so the port can mark the entry unavailable", async () => {
    mocks.count.mockRejectedValue(new Error("count failed"));
    const readers = createWorkLayerLiveReaders("p1");

    await expect(readers.readStaleProposalCount()).rejects.toThrow(
      "count failed",
    );
  });
});
