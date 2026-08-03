/**
 * Real-Chromium lifecycle coverage for the Scenes virtualizer.
 *
 * The Scenes scroll container and VirtualTree mount in the same commit when a
 * layout preset reopens the left region. A RefObject owned by the parent is not
 * available to the child's layout effect in that commit, so TanStack Virtual
 * never observes the container unless the resolved element causes a rerender.
 */
import { describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { useCallback, useRef, useState } from "react";
import { makeNodeData } from "@/test-utils/nodeFixture";
import type { VisibleTreeRow } from "./treeVisibility";

// test-setup-browser.ts の全件レンダ mock を、このファイルだけ実物へ戻す。
// browser mode では vi.unmock が mocker registry と競合するため importOriginal 経由。
vi.mock(
  "@tanstack/react-virtual",
  async (importOriginal) => await importOriginal(),
);
vi.mock("./TreeNodeItem", () => ({
  TreeNodeItem: ({
    node,
    virtualIndex,
    virtualStart,
    measureElement,
  }: {
    node: { id: string };
    virtualIndex?: number;
    virtualStart?: number;
    measureElement?: (element: HTMLLIElement | null) => void;
  }) => (
    <li
      ref={measureElement}
      data-node-id={node.id}
      data-index={virtualIndex}
      style={{
        height: 28,
        position: "absolute",
        insetInline: 0,
        top: 0,
        transform: `translateY(${virtualStart ?? 0}px)`,
      }}
    />
  ),
}));
vi.mock("@/features/editor/InlineSynopsisEditor", () => ({
  InlineSynopsisEditor: () => null,
}));

import { VirtualTree } from "./VirtualTree";

const ROWS: VisibleTreeRow[] = Array.from({ length: 4 }, (_, index) => ({
  node: makeNodeData({ id: `scene-${index}`, sortOrder: `a${index}` }),
  depth: 0,
}));

function PresetReopenHarness({ open }: { open: boolean }) {
  const treeRef = useRef<HTMLDivElement>(null);
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(
    null,
  );
  const bindScrollElement = useCallback((element: HTMLDivElement | null) => {
    treeRef.current = element;
    setScrollElement(element);
  }, []);
  const orderedNodesRef = useRef(ROWS.map((row) => row.node));

  if (!open) return null;

  return (
    <div
      ref={bindScrollElement}
      data-testid="tree-scroll"
      style={{ height: 160, overflowY: "auto" }}
    >
      <VirtualTree
        rows={ROWS}
        scrollElement={scrollElement}
        activeSceneId=""
        selectedIds={[]}
        expandedIds={[]}
        viewMode="tree"
        showWordCounts={false}
        showStatusDots={false}
        showLabelDots={false}
        showPlotThreadTrack={false}
        showAiAttribution={false}
        orderedNodesRef={orderedNodesRef}
        draggingId={null}
        autoRevealActiveScene={false}
        pendingRevealId={null}
        onPendingRevealHandled={() => {}}
        autoExpandFolders={false}
      />
    </div>
  );
}

describe("VirtualTree preset reopen lifecycle", () => {
  it("observes the resolved scroll element after a closed panel reopens", async () => {
    const { container, rerender } = render(<PresetReopenHarness open />);

    await waitFor(() => {
      expect(container.querySelectorAll("[data-node-id]")).toHaveLength(4);
    });

    rerender(<PresetReopenHarness open={false} />);
    expect(container.querySelectorAll("[data-node-id]")).toHaveLength(0);

    rerender(<PresetReopenHarness open />);
    await waitFor(() => {
      expect(container.querySelectorAll("[data-node-id]")).toHaveLength(4);
    });
  });
});
