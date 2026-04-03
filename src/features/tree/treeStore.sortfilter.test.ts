import { describe, it, expect, beforeEach, vi } from "vitest";
import { useTreeStore } from "./treeStore";

vi.mock("./api", () => ({
  listNodes: vi.fn().mockResolvedValue([]),
  createNode: vi.fn().mockImplementation((node) => Promise.resolve(node)),
  updateNode: vi.fn().mockResolvedValue(undefined),
  deleteNode: vi.fn().mockResolvedValue(undefined),
}));

function resetStore() {
  useTreeStore.setState({
    sortMode: "manual",
    statusFilter: null,
  });
}

describe("treeStore sortMode", () => {
  beforeEach(resetStore);

  it("defaults to 'manual'", () => {
    expect(useTreeStore.getState().sortMode).toBe("manual");
  });

  it("setSortMode updates sortMode", () => {
    useTreeStore.getState().setSortMode("title");
    expect(useTreeStore.getState().sortMode).toBe("title");
  });

  it("setSortMode accepts all valid modes", () => {
    const modes = ["manual", "title", "wordcount", "status"] as const;
    for (const mode of modes) {
      useTreeStore.getState().setSortMode(mode);
      expect(useTreeStore.getState().sortMode).toBe(mode);
    }
  });
});

describe("treeStore statusFilter", () => {
  beforeEach(resetStore);

  it("defaults to null (show all)", () => {
    expect(useTreeStore.getState().statusFilter).toBeNull();
  });

  it("setStatusFilter updates the filter", () => {
    useTreeStore.getState().setStatusFilter("draft");
    expect(useTreeStore.getState().statusFilter).toBe("draft");
  });

  it("setStatusFilter accepts null to clear filter", () => {
    useTreeStore.getState().setStatusFilter("complete");
    useTreeStore.getState().setStatusFilter(null);
    expect(useTreeStore.getState().statusFilter).toBeNull();
  });

  it("setStatusFilter accepts all valid statuses", () => {
    const statuses = [
      "outline",
      "draft",
      "complete",
      "revision",
      "final",
    ] as const;
    for (const status of statuses) {
      useTreeStore.getState().setStatusFilter(status);
      expect(useTreeStore.getState().statusFilter).toBe(status);
    }
  });
});
