import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  loadContainerId,
  saveContainerId,
  clearContainerId,
} from "../gridContainerPersistence";
import {
  getProjectSetting,
  setProjectSetting,
  deleteProjectSetting,
} from "@/features/settings/api";

vi.mock("@/features/settings/api", () => ({
  getProjectSetting: vi.fn(),
  setProjectSetting: vi.fn(),
  deleteProjectSetting: vi.fn(),
}));

const mockGet = vi.mocked(getProjectSetting);
const mockSet = vi.mocked(setProjectSetting);
const mockDelete = vi.mocked(deleteProjectSetting);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("loadContainerId", () => {
  it("returns stored value when present", async () => {
    mockGet.mockResolvedValueOnce("folder-abc");
    const result = await loadContainerId("proj-1");
    expect(result).toBe("folder-abc");
    expect(mockGet).toHaveBeenCalledWith("proj-1", "grid.containerId");
  });

  it("returns null when no value stored", async () => {
    mockGet.mockResolvedValueOnce(null);
    const result = await loadContainerId("proj-1");
    expect(result).toBeNull();
  });

  it("is project-scoped (different projects are independent)", async () => {
    mockGet.mockResolvedValueOnce("folder-for-proj1");
    mockGet.mockResolvedValueOnce("folder-for-proj2");

    const r1 = await loadContainerId("proj-1");
    const r2 = await loadContainerId("proj-2");

    expect(r1).toBe("folder-for-proj1");
    expect(r2).toBe("folder-for-proj2");
    expect(mockGet).toHaveBeenNthCalledWith(1, "proj-1", "grid.containerId");
    expect(mockGet).toHaveBeenNthCalledWith(2, "proj-2", "grid.containerId");
  });
});

describe("saveContainerId", () => {
  it("calls setProjectSetting with correct key and value", async () => {
    mockSet.mockResolvedValueOnce(undefined);
    await saveContainerId("proj-1", "folder-xyz");
    expect(mockSet).toHaveBeenCalledWith(
      "proj-1",
      "grid.containerId",
      "folder-xyz",
    );
  });
});

describe("clearContainerId", () => {
  it("calls deleteProjectSetting with correct key", async () => {
    mockDelete.mockResolvedValueOnce(undefined);
    await clearContainerId("proj-1");
    expect(mockDelete).toHaveBeenCalledWith("proj-1", "grid.containerId");
  });
});
