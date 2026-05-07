// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TagSelector } from "./TagSelector";
import { useGlobalHistoryStore } from "@/store/globalHistoryStore";

vi.mock("../tagApi", () => ({
  listCodexTags: vi.fn(async () => [
    {
      id: "t1",
      projectId: "p",
      name: "tagA",
      color: "#888",
      typeFilter: null,
    },
  ]),
  createCodexTag: vi.fn(),
  deleteCodexTag: vi.fn(),
  setEntryTags: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

describe("TagSelector rollback", () => {
  beforeEach(() => {
    useGlobalHistoryStore.getState().clear();
    vi.clearAllMocks();
  });

  it("rolls back state and skips history push when persist fails on toggle", async () => {
    const persistTags = vi.fn(async () => {
      throw new Error("persist boom");
    });
    const onTagsChange = vi.fn();

    render(
      <TagSelector
        entryId="e1"
        entryType="character"
        projectId="p"
        selectedTags={[]}
        onTagsChange={onTagsChange}
        persistTags={persistTags}
      />,
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /タグを追加/ }));
    const tagButton = await screen.findByText("tagA");
    await user.click(tagButton);

    await waitFor(() => {
      expect(persistTags).toHaveBeenCalled();
    });

    // Optimistic add then rollback
    expect(onTagsChange).toHaveBeenNthCalledWith(1, [
      expect.objectContaining({ id: "t1" }),
    ]);
    expect(onTagsChange).toHaveBeenLastCalledWith([]);

    // No history entry created
    expect(useGlobalHistoryStore.getState().past).toHaveLength(0);
  });
});
