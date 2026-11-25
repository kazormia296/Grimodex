import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  policy: vi.fn(),
  enabled: vi.fn(),
  count: vi.fn(),
  syncProject: vi.fn(),
  hostProjectId: null as string | null,
  selectCandidateCount: vi.fn(),
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
    getState: () => ({
      projectId: mocks.hostProjectId,
      syncProject: mocks.syncProject,
    }),
    subscribe: () => () => {},
  },
  selectCodexCandidateCount: mocks.selectCandidateCount,
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

import type { useCodexStore } from "@/features/codex/codexStore";
import { createWorkLayerLiveReaders } from "./workLayerLiveReaders";

const entries = [{ id: "entry-0001" }];
const unsubscribeEntries = vi.fn();
let entriesListener: ((state: unknown, previous: unknown) => void) | null =
  null;
const codexStore = {
  getState: () => ({ entries }),
  subscribe: (listener: (state: unknown, previous: unknown) => void) => {
    entriesListener = listener;
    return unsubscribeEntries;
  },
} as unknown as typeof useCodexStore;

describe("createWorkLayerLiveReaders: readStaleProposalCount", () => {
  beforeEach(() => {
    mocks.policy.mockReset().mockResolvedValue({});
    mocks.enabled.mockReset().mockReturnValue(true);
    mocks.count.mockReset();
    mocks.syncProject.mockReset();
  });

  it("reads only the count (never the whole Inbox) for the project", async () => {
    mocks.count.mockResolvedValue(7);
    const readers = createWorkLayerLiveReaders("p1", codexStore);

    await expect(readers.readStaleProposalCount()).resolves.toEqual({
      allowed: true,
      count: 7,
    });
    expect(mocks.count).toHaveBeenCalledTimes(1);
    expect(mocks.count).toHaveBeenCalledWith({ projectId: "p1" });
  });

  it("does not read the count when maintenance is not allowed", async () => {
    mocks.enabled.mockReturnValue(false);
    const readers = createWorkLayerLiveReaders("p1", codexStore);

    await expect(readers.readStaleProposalCount()).resolves.toEqual({
      allowed: false,
    });
    expect(mocks.count).not.toHaveBeenCalled();
  });

  it("lets a failed read reject so the port can mark the entry unavailable", async () => {
    mocks.count.mockRejectedValue(new Error("count failed"));
    const readers = createWorkLayerLiveReaders("p1", codexStore);

    await expect(readers.readStaleProposalCount()).rejects.toThrow(
      "count failed",
    );
  });
});

describe("createWorkLayerLiveReaders: candidate count", () => {
  beforeEach(() => {
    mocks.hostProjectId = "p1";
    mocks.selectCandidateCount.mockReset().mockReturnValue({ status: "ready" });
    unsubscribeEntries.mockReset();
    entriesListener = null;
  });

  it("counts against, and listens to, the Codex store it is given", () => {
    const readers = createWorkLayerLiveReaders("p1", codexStore);

    readers.readCandidateCount();
    expect(mocks.selectCandidateCount).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "p1" }),
      entries,
    );

    const listener = vi.fn();
    const unsubscribe = readers.subscribeCandidateCount(listener);
    entriesListener?.({ entries: [] }, { entries });
    expect(listener).toHaveBeenCalledTimes(1);
    entriesListener?.({ entries }, { entries });
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    expect(unsubscribeEntries).toHaveBeenCalledTimes(1);
  });
});
