// @vitest-environment happy-dom
import { useCallback } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ReactFlow,
  useNodesState,
  type Node,
  type NodeTypes,
} from "@xyflow/react";
import { StickyNode, type StickyNodeData } from "./StickyNode";
import { _resetQuiescenceParticipantsForTests } from "@/application/lifecycle/quiescenceParticipants";
import { _resetQuiescenceLeasesForTests } from "@/application/lifecycle/quiescenceLease";
import { expectNoA11yViolations } from "@/test-utils/axe";

vi.mock("motion/react", () => ({
  useReducedMotion: () => false,
  motion: {
    div: ({
      children,
      initial: _initial,
      animate: _animate,
      transition: _transition,
      onAnimationComplete: _onAnimationComplete,
      ...props
    }: React.HTMLAttributes<HTMLDivElement> & {
      children?: React.ReactNode;
      initial?: unknown;
      animate?: unknown;
      transition?: unknown;
      onAnimationComplete?: () => void;
    }) => <div {...props}>{children}</div>,
  },
}));

vi.mock("@tiptap/core", () => ({
  generateHTML: () => "<p>body</p>",
}));

vi.mock("@/features/editor/extensions", () => ({
  getStickyEditorExtensions: () => [],
}));

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const nodeTypes: NodeTypes = { sticky: StickyNode };

const initialNodes: Node[] = [
  {
    id: "sticky:test-1",
    type: "sticky",
    position: { x: 20, y: 20 },
    width: 200,
    height: 100,
    ariaLabel: "Test sticky",
    data: {
      id: "test-1",
      title: "Test sticky",
      body: '{"type":"doc","content":[]}',
      previewText: "body",
      paletteId: "post-it-playful",
      colorSlot: 0,
      branchAttached: true,
      onAdopt: vi.fn(),
      onReject: vi.fn(),
    } satisfies StickyNodeData,
  },
];

function ReactFlowStickyHarness() {
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const handleNodesChange = useCallback(
    (changes: Parameters<typeof onNodesChange>[0]) => {
      onNodesChange(changes);
    },
    [onNodesChange],
  );

  return (
    <div style={{ width: 600, height: 400 }}>
      <ReactFlow
        nodes={nodes}
        edges={[]}
        nodeTypes={nodeTypes}
        onNodesChange={handleNodesChange}
        onNodeClick={(_, node) => {
          setNodes((current) =>
            current.map((candidate) => ({
              ...candidate,
              selected: candidate.id === node.id,
            })),
          );
        }}
      />
    </div>
  );
}

describe("StickyNode ReactFlow keyboard contract", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    _resetQuiescenceLeasesForTests();
    _resetQuiescenceParticipantsForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    _resetQuiescenceLeasesForTests();
    _resetQuiescenceParticipantsForTests();
  });

  it("uses ReactFlow's focusable wrapper as the only node tab stop and exposes toolbar actions after keyboard selection", async () => {
    render(<ReactFlowStickyHarness />);

    const wrapper = await screen.findByTestId("rf__node-sticky:test-1");
    expect(wrapper).toHaveAttribute("tabindex", "0");
    expect(wrapper).toHaveAttribute("role", "group");
    expect(wrapper).toHaveAccessibleName("Test sticky");
    expect(wrapper.querySelector('[tabindex="0"]')).toBeNull();
    expect(screen.queryByRole("button", { name: "この付箋を採用" })).toBeNull();

    wrapper.focus();
    act(() => {
      fireEvent.keyDown(wrapper, { key: "Enter", code: "Enter" });
    });

    await waitFor(() => expect(wrapper).toHaveClass("selected"));
    const adopt = await screen.findByRole("button", {
      name: "この付箋を採用",
    });
    adopt.focus();
    expect(adopt).toHaveFocus();
    await expectNoA11yViolations(document.body);
  });
});
