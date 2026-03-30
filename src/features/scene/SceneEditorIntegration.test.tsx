import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SceneEditor } from "./SceneEditor";
import { useSceneStore } from "./store";

function resetStore() {
  useSceneStore.setState(useSceneStore.getInitialState());
}

describe("SceneEditor integration", () => {
  beforeEach(() => {
    resetStore();
  });

  it("renders editor for the active scene", () => {
    render(<SceneEditor />);
    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });

  it("preserves content when switching between scenes", async () => {
    const user = userEvent.setup();

    // Create second scene
    useSceneStore.getState().createScene();
    const { scenes } = useSceneStore.getState();

    render(<SceneEditor />);

    // Type in first scene
    const editor = screen.getByRole("textbox");
    await user.click(editor);
    await user.type(editor, "シーン1のテキスト");

    // Store should have content for scene 1
    const scene1Content = useSceneStore.getState().scenes[0].content;
    expect(scene1Content.length).toBeGreaterThan(0);

    // Switch to scene 2
    useSceneStore.getState().setActiveScene(scenes[1].id);

    // Switch back to scene 1
    useSceneStore.getState().setActiveScene(scenes[0].id);

    // Content should be preserved
    const restored = useSceneStore.getState().scenes[0].content;
    expect(restored).toBe(scene1Content);
  });

  it("shows different content per scene", () => {
    useSceneStore.getState().createScene();
    const { scenes } = useSceneStore.getState();

    // Set content for each scene directly in store
    useSceneStore
      .getState()
      .updateSceneContent(scenes[0].id, "<p>First scene</p>");
    useSceneStore
      .getState()
      .updateSceneContent(scenes[1].id, "<p>Second scene</p>");

    const state = useSceneStore.getState();
    expect(state.scenes[0].content).toBe("<p>First scene</p>");
    expect(state.scenes[1].content).toBe("<p>Second scene</p>");
  });
});
