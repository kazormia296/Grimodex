// @vitest-environment happy-dom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReactFlow, type Node, type NodeTypes } from "@xyflow/react";
import {
  _resetQuiescenceParticipantsForTests,
  flushQuiescenceParticipants,
} from "@/application/lifecycle/quiescenceParticipants";
import {
  _resetPendingSynopsisSavesForTests,
  flushPendingSynopsisSaves,
} from "@/features/editor/pendingSynopsisSaves";
import { SceneNode, type SceneNodeData } from "./SceneNode";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const nodeTypes: NodeTypes = { scene: SceneNode };

function makeSceneNode(
  onSynopsisChange: (synopsis: string) => Promise<void>,
  onTitleChange: (title: string) => Promise<void> = vi
    .fn()
    .mockResolvedValue(undefined),
): Node {
  return {
    id: "scene:scene-1",
    type: "scene",
    position: { x: 20, y: 20 },
    data: {
      treeNodeId: "scene-1",
      title: "Scene title",
      synopsis: "Original synopsis",
      status: "draft",
      variant: "card",
      colorBy: "none",
      onTitleChange,
      onSynopsisChange,
    } satisfies SceneNodeData,
  };
}

function renderScene(
  onSynopsisChange: (synopsis: string) => Promise<void>,
  onTitleChange?: (title: string) => Promise<void>,
) {
  return render(
    <div style={{ width: 600, height: 400 }}>
      <ReactFlow
        nodes={[makeSceneNode(onSynopsisChange, onTitleChange)]}
        edges={[]}
        nodeTypes={nodeTypes}
      />
    </div>,
  );
}

describe("SceneNode synopsis persistence", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    _resetPendingSynopsisSavesForTests();
    _resetQuiescenceParticipantsForTests();
  });

  afterEach(async () => {
    await flushPendingSynopsisSaves().catch(() => {});
    _resetPendingSynopsisSavesForTests();
    _resetQuiescenceParticipantsForTests();
    vi.unstubAllGlobals();
  });

  it("keeps IME composition keys local and persists the title on strict flush", async () => {
    const onSynopsisChange = vi.fn().mockResolvedValue(undefined);
    const onTitleChange = vi.fn().mockResolvedValue(undefined);
    renderScene(onSynopsisChange, onTitleChange);

    fireEvent.doubleClick(await screen.findByText("Scene title"));
    const editor = await screen.findByDisplayValue("Scene title");
    fireEvent.change(editor, { target: { value: "変換中のシーン名" } });
    fireEvent.keyDown(editor, { key: "Enter", isComposing: true });
    fireEvent.keyDown(editor, { key: "Escape", isComposing: true });

    expect(onTitleChange).not.toHaveBeenCalled();
    expect(editor).toHaveValue("変換中のシーン名");

    await flushQuiescenceParticipants();
    expect(onTitleChange).toHaveBeenCalledOnce();
    expect(onTitleChange).toHaveBeenCalledWith("変換中のシーン名", {
      preexistingDraft: true,
    });
  });

  it("retains the title editor when strict persistence fails", async () => {
    const onSynopsisChange = vi.fn().mockResolvedValue(undefined);
    const onTitleChange = vi.fn().mockRejectedValue(new Error("disk full"));
    renderScene(onSynopsisChange, onTitleChange);

    fireEvent.doubleClick(await screen.findByText("Scene title"));
    const editor = await screen.findByDisplayValue("Scene title");
    fireEvent.change(editor, { target: { value: "Unsaved map title" } });

    await expect(flushQuiescenceParticipants()).rejects.toThrow(
      "One or more lifecycle participants failed to flush",
    );
    expect(editor).toHaveValue("Unsaved map title");
    expect(onTitleChange).toHaveBeenCalledWith("Unsaved map title", {
      preexistingDraft: true,
    });
  });

  it("flushes the latest debounced synopsis when the node unmounts", async () => {
    const onSynopsisChange = vi.fn().mockResolvedValue(undefined);
    const view = renderScene(onSynopsisChange);

    fireEvent.doubleClick(await screen.findByText("Original synopsis"));
    const editor =
      await screen.findByPlaceholderText("このシーンで何が起きる？");
    fireEvent.change(editor, { target: { value: "Latest map synopsis" } });

    expect(onSynopsisChange).not.toHaveBeenCalled();
    await act(async () => {
      view.unmount();
      await flushPendingSynopsisSaves();
    });

    expect(onSynopsisChange).toHaveBeenCalledTimes(1);
    expect(onSynopsisChange).toHaveBeenCalledWith("Latest map synopsis");
  });

  it("does not persist a cancelled synopsis draft", async () => {
    const onSynopsisChange = vi.fn().mockResolvedValue(undefined);
    const view = renderScene(onSynopsisChange);

    fireEvent.doubleClick(await screen.findByText("Original synopsis"));
    const editor =
      await screen.findByPlaceholderText("このシーンで何が起きる？");
    fireEvent.change(editor, { target: { value: "Cancelled map synopsis" } });
    fireEvent.keyDown(editor, { key: "Escape", code: "Escape" });

    await waitFor(() =>
      expect(
        screen.queryByPlaceholderText("このシーンで何が起きる？"),
      ).not.toBeInTheDocument(),
    );
    view.unmount();
    await flushPendingSynopsisSaves();

    expect(onSynopsisChange).not.toHaveBeenCalled();
  });

  it("does not commit or cancel a synopsis for IME composition keys", async () => {
    const onSynopsisChange = vi.fn().mockResolvedValue(undefined);
    const view = renderScene(onSynopsisChange);

    fireEvent.doubleClick(await screen.findByText("Original synopsis"));
    const editor =
      await screen.findByPlaceholderText("このシーンで何が起きる？");
    fireEvent.change(editor, { target: { value: "変換中の梗概" } });
    fireEvent.keyDown(editor, { key: "Escape", isComposing: true });
    fireEvent.keyDown(editor, {
      key: "Enter",
      ctrlKey: true,
      isComposing: true,
    });

    expect(editor).toHaveValue("変換中の梗概");
    expect(onSynopsisChange).not.toHaveBeenCalled();

    await act(async () => {
      view.unmount();
      await flushPendingSynopsisSaves();
    });
    expect(onSynopsisChange).toHaveBeenCalledWith("変換中の梗概");
  });
});
