// @vitest-environment happy-dom
import { useRef } from "react";
import { DndContext } from "@dnd-kit/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeNodeData } from "@/test-utils/nodeFixture";
import { TreeNodeItem } from "./TreeNodeItem";
import { useTreeStore } from "./treeStore";
import {
  resetTreeVirtualEditingForTests,
  useTreeVirtualEditingStore,
} from "./treeVirtualEditingStore";
import {
  _resetQuiescenceParticipantsForTests,
  collectQuiescenceParticipantRecovery,
  flushQuiescenceParticipants,
} from "@/application/lifecycle/quiescenceParticipants";

const originalUpdateNodeTitle = useTreeStore.getState().updateNodeTitle;
const updateNodeTitle = vi.fn().mockResolvedValue(undefined);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function Harness() {
  const node = makeNodeData({
    id: "scene-1",
    projectId: "project-1",
    title: "Original title",
  });
  const orderedNodesRef = useRef([node]);
  return (
    <DndContext>
      <ul>
        <TreeNodeItem
          node={node}
          depth={0}
          isActive={false}
          isSelected={false}
          isExpanded={false}
          showWordCounts={false}
          showStatusDots={false}
          showLabelDots={false}
          showPlotThreadTrack={false}
          showAiAttribution={false}
          orderedNodesRef={orderedNodesRef}
          dragInProgress={false}
        />
      </ul>
    </DndContext>
  );
}

beforeEach(() => {
  _resetQuiescenceParticipantsForTests();
  resetTreeVirtualEditingForTests();
  updateNodeTitle.mockReset();
  updateNodeTitle.mockResolvedValue(undefined);
  useTreeStore.setState({
    pendingRenameId: "scene-1",
    charCounts: {},
    aiRatios: {},
    updateNodeTitle,
  });
});

afterEach(() => {
  _resetQuiescenceParticipantsForTests();
  resetTreeVirtualEditingForTests();
  useTreeStore.setState({
    pendingRenameId: null,
    updateNodeTitle: originalUpdateNodeTitle,
  });
});

describe("TreeNodeItem virtual editing", () => {
  it("commits a title once and releases its pinned row after persistence", async () => {
    render(<Harness />);

    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "Committed title" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(updateNodeTitle).toHaveBeenCalledTimes(1);
    expect(updateNodeTitle).toHaveBeenCalledWith("scene-1", "Committed title");
    await waitFor(() =>
      expect(
        useTreeVirtualEditingStore.getState().editingRowIds.has("scene-1"),
      ).toBe(false),
    );
  });

  it("keeps a failed title draft pinned and exposes it for strict retry", async () => {
    updateNodeTitle.mockRejectedValueOnce(new Error("disk full"));
    render(<Harness />);

    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "Recoverable title" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(updateNodeTitle).toHaveBeenCalledOnce());
    expect(screen.getByRole("textbox")).toHaveValue("Recoverable title");
    expect(
      useTreeVirtualEditingStore.getState().editingRowIds.has("scene-1"),
    ).toBe(true);
    expect(collectQuiescenceParticipantRecovery()).toEqual([
      {
        kind: "tree-node-title",
        nodeId: "scene-1",
        title: "Recoverable title",
      },
    ]);

    updateNodeTitle.mockResolvedValueOnce(undefined);
    await flushQuiescenceParticipants();
    await waitFor(() =>
      expect(
        useTreeVirtualEditingStore.getState().editingRowIds.has("scene-1"),
      ).toBe(false),
    );
  });

  it("drains a title changed during save before releasing the pinned row", async () => {
    const first = deferred();
    const latest = deferred();
    updateNodeTitle
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => latest.promise);
    render(<Harness />);

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "First title" },
    });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    await waitFor(() =>
      expect(updateNodeTitle).toHaveBeenNthCalledWith(
        1,
        "scene-1",
        "First title",
      ),
    );

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Latest title" },
    });
    first.resolve();
    await waitFor(() =>
      expect(updateNodeTitle).toHaveBeenNthCalledWith(
        2,
        "scene-1",
        "Latest title",
      ),
    );
    expect(
      useTreeVirtualEditingStore.getState().editingRowIds.has("scene-1"),
    ).toBe(true);

    latest.resolve();
    await waitFor(() =>
      expect(
        useTreeVirtualEditingStore.getState().editingRowIds.has("scene-1"),
      ).toBe(false),
    );
  });

  it("pins a title draft until explicit cancel and Escape does not commit it", () => {
    render(<Harness />);

    const input = screen.getByRole("textbox");
    expect(
      useTreeVirtualEditingStore.getState().editingRowIds.has("scene-1"),
    ).toBe(true);

    fireEvent.change(input, { target: { value: "Discard this draft" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(
      useTreeVirtualEditingStore.getState().editingRowIds.has("scene-1"),
    ).toBe(false);
    expect(updateNodeTitle).not.toHaveBeenCalled();
  });

  it("does not commit or cancel a title on IME composition keys", () => {
    render(<Harness />);

    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "変換中" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.keyDown(input, { key: "Escape", isComposing: true });

    expect(updateNodeTitle).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox")).toHaveValue("変換中");
    expect(
      useTreeVirtualEditingStore.getState().editingRowIds.has("scene-1"),
    ).toBe(true);

    fireEvent.keyDown(input, { key: "Escape" });
  });

  it("balances the editing registration when the tree surface unmounts", () => {
    const { unmount } = render(<Harness />);
    expect(
      useTreeVirtualEditingStore.getState().editingRowIds.has("scene-1"),
    ).toBe(true);

    unmount();

    expect(
      useTreeVirtualEditingStore.getState().editingRowIds.has("scene-1"),
    ).toBe(false);
  });
});
