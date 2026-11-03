import { useRef } from "react";
import { DndContext } from "@dnd-kit/core";
import { render } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeNodeData } from "@/test-utils/nodeFixture";
import type { TreeNodeData } from "./types";
import { TreeNodeItem } from "./TreeNodeItem";
import { useTreeStore } from "./treeStore";
import { resetTreeVirtualEditingForTests } from "./treeVirtualEditingStore";
import { _resetQuiescenceParticipantsForTests } from "@/application/lifecycle/quiescenceParticipants";

function Harness({ node }: { node: TreeNodeData }) {
  const orderedNodesRef = useRef([node]);
  return (
    <DndContext>
      {/* 実物のツリーのスクロール領域と同じく、フォーカスを受ける容器 */}
      <ul tabIndex={-1} data-testid="tree-scroll">
        <TreeNodeItem
          node={node}
          depth={0}
          isActive={false}
          isSelected={false}
          isExpanded={false}
          showWordCounts
          showStatusDots
          showLabelDots
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
  useTreeStore.setState({
    pendingRenameId: null,
    charCounts: {},
    aiRatios: {},
  });
});
afterEach(() => {
  _resetQuiescenceParticipantsForTests();
  resetTreeVirtualEditingForTests();
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.each(["scene", "folder"] as const)("%s rename", (nodeType) => {
  it("keeps focus in the rename input after choosing Rename", async () => {
    const node = makeNodeData({ id: `${nodeType}-1`, nodeType, title: "Old" });
    const { container } = render(<Harness node={node} />);
    const row = container.querySelector(`[data-node-row="${node.id}"]`)!;
    await userEvent.click(row as HTMLElement, { button: "right" });
    const item = await new Promise<HTMLElement>((resolve) => {
      const tick = () => {
        const el = [...document.querySelectorAll('[role="menuitem"]')].find(
          (e) => e.textContent?.includes("F2"),
        ) as HTMLElement | undefined;
        if (el) resolve(el);
        else setTimeout(tick, 20);
      };
      tick();
    });
    await userEvent.click(item);
    await wait(400);
    const input = container.querySelector("input");
    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(input);
  });
});
