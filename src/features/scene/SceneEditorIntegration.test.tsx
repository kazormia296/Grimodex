import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { SceneEditor } from "./SceneEditor";
import { useSceneStore } from "./store";

vi.mock("./api", () => ({
  loadSceneContent: vi.fn().mockResolvedValue(""),
  saveSceneContent: vi.fn().mockResolvedValue(undefined),
  renameSceneContent: vi.fn().mockResolvedValue(undefined),
  listScenes: vi.fn().mockResolvedValue([]),
  createScene: vi.fn(),
  deleteScene: vi.fn(),
  updateScene: vi.fn(),
}));

function resetStore() {
  useSceneStore.setState({
    scenes: [
      { id: "s1", title: "シーン 1", sortOrder: 0 },
      { id: "s2", title: "シーン 2", sortOrder: 1 },
    ],
    activeSceneId: "s1",
    isLoading: false,
  });
}

describe("SceneEditor integration", () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
  });

  it("renders editor for the active scene", () => {
    render(<SceneEditor />);
    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });

  it("loads content from API when active scene changes", async () => {
    const { loadSceneContent } = await import("./api");
    (loadSceneContent as ReturnType<typeof vi.fn>).mockResolvedValue(
      "# Scene 1 content",
    );

    render(<SceneEditor />);

    // loadSceneContent should be called for the active scene
    expect(loadSceneContent).toHaveBeenCalledWith("s1");
  });
});
