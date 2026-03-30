import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Sidebar } from "./Sidebar";
import { useSceneStore } from "./store";

function resetStore() {
  useSceneStore.setState(useSceneStore.getInitialState());
}

describe("Sidebar", () => {
  beforeEach(() => {
    resetStore();
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
      expect(screen.getByText("シーン 2")).toBeInTheDocument();
    });
  });

  describe("scene switching", () => {
    it("switches active scene on click", async () => {
      const user = userEvent.setup();
      useSceneStore.getState().createScene();
      render(<Sidebar />);
      await user.click(screen.getByText("シーン 2"));
      const { activeSceneId, scenes } = useSceneStore.getState();
      expect(activeSceneId).toBe(scenes[1].id);
    });
  });

  describe("scene deletion", () => {
    it("deletes a scene when delete button is clicked", async () => {
      const user = userEvent.setup();
      useSceneStore.getState().createScene();
      render(<Sidebar />);
      const item = screen
        .getByText("シーン 2")
        .closest("[data-testid^='scene-item-']")!;
      const deleteBtn = within(item as HTMLElement).getByRole("button", {
        name: /削除/i,
      });
      await user.click(deleteBtn);
      expect(screen.queryByText("シーン 2")).not.toBeInTheDocument();
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
      expect(screen.getByText("プロローグ")).toBeInTheDocument();
      expect(useSceneStore.getState().scenes[0].title).toBe("プロローグ");
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
