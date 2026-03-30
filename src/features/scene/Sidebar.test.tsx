import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Sidebar } from "./Sidebar";
import { useSceneStore } from "./store";

const mockCreateScene = vi.fn().mockImplementation((data) =>
  Promise.resolve({
    ...data,
    synopsis: "",
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
  }),
);

const mockDeleteScene = vi.fn().mockResolvedValue(undefined);
const mockUpdateScene = vi.fn().mockResolvedValue(undefined);
const mockListScenes = vi
  .fn()
  .mockResolvedValue([makeDbScene("s1", "シーン 1", 0)]);

function makeDbScene(id: string, title: string, sortOrder: number) {
  return {
    id,
    chapterId: 1,
    title,
    sortOrder,
    synopsis: "",
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
  };
}

vi.mock("./api", () => ({
  listScenes: (...args: unknown[]) => mockListScenes(...args),
  createScene: (...args: unknown[]) => mockCreateScene(...args),
  deleteScene: (...args: unknown[]) => mockDeleteScene(...args),
  updateScene: (...args: unknown[]) => mockUpdateScene(...args),
}));

function setStoreWithScenes(
  scenes = [{ id: "s1", title: "シーン 1", sortOrder: 0 }],
) {
  useSceneStore.setState({
    scenes,
    activeSceneId: scenes[0]?.id ?? "",
    isLoading: false,
  });
}

describe("Sidebar", () => {
  beforeEach(() => {
    setStoreWithScenes();
    vi.clearAllMocks();
  });

  it("renders a scene list", () => {
    render(<Sidebar />);
    expect(screen.getByRole("navigation")).toBeInTheDocument();
    expect(screen.getByText("シーン 1")).toBeInTheDocument();
  });

  it("highlights the active scene", () => {
    render(<Sidebar />);
    const item = screen
      .getByText("シーン 1")
      .closest("[data-testid^='scene-item-']");
    expect(item).toHaveAttribute("data-active", "true");
  });

  describe("scene creation", () => {
    it("creates a new scene when add button is clicked", async () => {
      const user = userEvent.setup();
      render(<Sidebar />);
      const addBtn = screen.getByRole("button", { name: /シーン追加/i });
      await user.click(addBtn);
      await waitFor(() => {
        expect(mockCreateScene).toHaveBeenCalled();
      });
    });
  });

  describe("scene switching", () => {
    it("switches active scene on click", async () => {
      const user = userEvent.setup();
      mockListScenes.mockResolvedValueOnce([
        makeDbScene("s1", "シーン 1", 0),
        makeDbScene("s2", "シーン 2", 1),
      ]);
      setStoreWithScenes([
        { id: "s1", title: "シーン 1", sortOrder: 0 },
        { id: "s2", title: "シーン 2", sortOrder: 1 },
      ]);
      render(<Sidebar />);
      await user.click(screen.getByText("シーン 2"));
      const { activeSceneId } = useSceneStore.getState();
      expect(activeSceneId).toBe("s2");
    });
  });

  describe("scene deletion", () => {
    it("deletes a scene when delete button is clicked", async () => {
      const user = userEvent.setup();
      mockListScenes.mockResolvedValueOnce([
        makeDbScene("s1", "シーン 1", 0),
        makeDbScene("s2", "シーン 2", 1),
      ]);
      setStoreWithScenes([
        { id: "s1", title: "シーン 1", sortOrder: 0 },
        { id: "s2", title: "シーン 2", sortOrder: 1 },
      ]);
      render(<Sidebar />);
      const item = screen
        .getByText("シーン 2")
        .closest("[data-testid^='scene-item-']")!;
      const deleteBtn = within(item as HTMLElement).getByRole("button", {
        name: /削除/i,
      });
      await user.click(deleteBtn);
      await waitFor(() => {
        expect(mockDeleteScene).toHaveBeenCalledWith("s2");
      });
    });

    it("does not show delete button when only one scene exists", () => {
      render(<Sidebar />);
      expect(
        screen.queryByRole("button", { name: /削除/i }),
      ).not.toBeInTheDocument();
    });
  });

  describe("scene renaming", () => {
    it("enters rename mode on double-click", async () => {
      const user = userEvent.setup();
      render(<Sidebar />);
      await user.dblClick(screen.getByText("シーン 1"));
      expect(screen.getByRole("textbox")).toHaveValue("シーン 1");
    });

    it("saves renamed title on Enter", async () => {
      const user = userEvent.setup();
      render(<Sidebar />);
      await user.dblClick(screen.getByText("シーン 1"));
      const input = screen.getByRole("textbox");
      await user.clear(input);
      await user.type(input, "プロローグ{Enter}");
      await waitFor(() => {
        expect(mockUpdateScene).toHaveBeenCalledWith("s1", {
          title: "プロローグ",
        });
      });
    });

    it("cancels rename on Escape", async () => {
      const user = userEvent.setup();
      render(<Sidebar />);
      await user.dblClick(screen.getByText("シーン 1"));
      const input = screen.getByRole("textbox");
      await user.clear(input);
      await user.type(input, "変更テスト{Escape}");
      expect(screen.getByText("シーン 1")).toBeInTheDocument();
    });
  });
});
