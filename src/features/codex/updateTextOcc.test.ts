import { describe, it, expect, vi, beforeEach } from "vitest";

const { updateCodexEntryMock } = vi.hoisted(() => ({
  updateCodexEntryMock: vi.fn(),
}));
vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return { ...actual, updateCodexEntry: updateCodexEntryMock };
});
vi.mock("@/features/timelapse/recorder", () => ({
  recordChangeEvent: vi.fn(),
}));
vi.mock("@/features/project/projectStore", () => ({
  getCurrentProjectId: () => "proj-1",
}));

import { useCodexStore, setCodexEditConflictHandler } from "./codexStore";
import { CodexVersionConflictError } from "./occ";

beforeEach(() => {
  updateCodexEntryMock.mockReset();
  setCodexEditConflictHandler(() => {}); // reset to no-op between tests
  useCodexStore.setState({
    selectedEntry: null,
    entries: [
      {
        id: "e1",
        version: 5,
        content: "old",
        name: "n",
      } as never,
    ],
  });
});

describe("codexStore.updateText OCC", () => {
  it("before.version を baseVersion として updateCodexEntry に渡す", async () => {
    updateCodexEntryMock.mockResolvedValueOnce({
      id: "e1",
      version: 6,
      content: "new",
    });
    await useCodexStore.getState().updateText("e1", { content: "new" });
    expect(updateCodexEntryMock).toHaveBeenCalledWith(
      "proj-1",
      "e1",
      { content: "new" },
      { baseVersion: 5 },
    );
  });

  it("成功時は store の該当 entry を更新する", async () => {
    updateCodexEntryMock.mockResolvedValueOnce({
      id: "e1",
      version: 6,
      content: "new",
    });
    await useCodexStore.getState().updateText("e1", { content: "new" });
    expect(useCodexStore.getState().entries[0].content).toBe("new");
  });

  it("filtered-out selectedEntry の version と更新結果を使う", async () => {
    useCodexStore.setState({
      entries: [],
      selectedEntry: {
        id: "e1",
        version: 5,
        summary: "old",
        name: "n",
      } as never,
    });
    updateCodexEntryMock.mockResolvedValueOnce({
      id: "e1",
      version: 6,
      summary: "new",
      name: "n",
    });

    await useCodexStore.getState().updateText("e1", { summary: "new" });

    expect(updateCodexEntryMock).toHaveBeenCalledWith(
      "proj-1",
      "e1",
      { summary: "new" },
      { baseVersion: 5 },
    );
    expect(useCodexStore.getState().selectedEntry?.summary).toBe("new");
  });

  it("衝突時は store を上書きせず conflict handler を entryId 付きで呼ぶ", async () => {
    updateCodexEntryMock.mockRejectedValueOnce(
      new CodexVersionConflictError("e1"),
    );
    const handler = vi.fn();
    setCodexEditConflictHandler(handler);
    await useCodexStore.getState().updateText("e1", { content: "new" });
    expect(handler).toHaveBeenCalledWith("e1");
    expect(useCodexStore.getState().entries[0].content).toBe("old"); // 非破壊
  });
});
