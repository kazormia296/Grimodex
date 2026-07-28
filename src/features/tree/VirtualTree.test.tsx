// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { useRef } from "react";
import { makeNodeData } from "@/test-utils/nodeFixture";
import type { VisibleTreeRow } from "./treeVisibility";

const capture = vi.hoisted(() => ({
  options: null as null | {
    count: number;
    getItemKey: (index: number) => string | number;
    rangeExtractor: (range: {
      startIndex: number;
      endIndex: number;
      overscan: number;
      count: number;
    }) => number[];
  },
}));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (options: NonNullable<typeof capture.options>) => {
    capture.options = options;
    return {
      getTotalSize: () => options.count * 28,
      getVirtualItems: () =>
        Array.from({ length: Math.min(2, options.count) }, (_, index) => ({
          index,
          key: options.getItemKey(index),
          start: index * 28,
          size: 28,
        })),
      measureElement: vi.fn(),
      scrollToIndex: vi.fn(),
    };
  },
}));

vi.mock("./TreeNodeItem", () => ({
  TreeNodeItem: ({
    node,
    virtualIndex,
  }: {
    node: { id: string };
    virtualIndex?: number;
  }) => <li data-node-id={node.id} data-index={virtualIndex} />,
}));
vi.mock("@/features/editor/InlineSynopsisEditor", () => ({
  InlineSynopsisEditor: () => null,
}));

import { extractTreeVirtualIndexes, VirtualTree } from "./VirtualTree";
import {
  beginTreeVirtualRowEditing,
  resetTreeVirtualEditingForTests,
} from "./treeVirtualEditingStore";

afterEach(() => {
  resetTreeVirtualEditingForTests();
});

function Harness({
  rows,
  dragging = false,
}: {
  rows: VisibleTreeRow[];
  dragging?: boolean;
}) {
  const treeRef = useRef<HTMLDivElement>(null);
  const orderedNodesRef = useRef(rows.map((row) => row.node));
  return (
    <div ref={treeRef}>
      <VirtualTree
        rows={rows}
        treeRef={treeRef}
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
        draggingId={dragging ? (rows[9_000]?.node.id ?? null) : null}
        autoRevealActiveScene={false}
        pendingRevealId={null}
        onPendingRevealHandled={() => {}}
        autoExpandFolders={false}
      />
    </div>
  );
}

describe("VirtualTree", () => {
  it("hands all rows to TanStack Virtual but mounts only its window", () => {
    const rows = Array.from({ length: 50 }, (_, index) => ({
      node: makeNodeData({ id: `scene-${index}`, sortOrder: `a${index}` }),
      depth: 0,
    }));
    const { container } = render(<Harness rows={rows} />);

    expect(capture.options?.count).toBe(50);
    expect(capture.options?.getItemKey(17)).toBe("scene-17");
    expect(container.querySelectorAll("[data-node-id]")).toHaveLength(2);
  });

  it("pins drag and editing rows while keeping the tree windowed", () => {
    const rows = Array.from({ length: 10_000 }, (_, index) => ({
      node: makeNodeData({ id: `scene-${index}` }),
      depth: 0,
    }));
    const releaseEditing = beginTreeVirtualRowEditing("scene-8000");
    render(<Harness rows={rows} dragging />);
    expect(
      capture.options?.rangeExtractor({
        startIndex: 100,
        endIndex: 105,
        overscan: 2,
        count: 10_000,
      }),
    ).toEqual([98, 99, 100, 101, 102, 103, 104, 105, 106, 107, 8_000, 9_000]);
    expect(
      extractTreeVirtualIndexes(
        {
          startIndex: 100,
          endIndex: 105,
          overscan: 2,
          count: 10_000,
        },
        [9_000, 8_000, 9_000, -1, 10_000],
      ),
    ).toEqual([98, 99, 100, 101, 102, 103, 104, 105, 106, 107, 8_000, 9_000]);
    releaseEditing();
  });
});
