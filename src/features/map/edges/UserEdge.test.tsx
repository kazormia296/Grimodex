// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UserEdge } from "./UserEdge";
import type { EdgeProps } from "@xyflow/react";

vi.mock("@xyflow/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();
  return {
    ...actual,
    BaseEdge: () => null,
    EdgeLabelRenderer: ({ children }: { children: React.ReactNode }) => (
      <>{children}</>
    ),
    getBezierPath: () => ["M0,0", 50, 50],
    // Stub useInternalNode so the floating-edge code path returns valid
    // node refs without requiring a real ReactFlowProvider in tests.
    useInternalNode: () => ({
      measured: { width: 100, height: 50 },
      internals: { positionAbsolute: { x: 0, y: 0 } },
    }),
  };
});

vi.mock("./floatingEdge", () => ({
  getFloatingEdgeParams: () => ({
    sx: 0,
    sy: 0,
    tx: 100,
    ty: 100,
    sourcePos: "right",
    targetPos: "left",
  }),
}));

function makeProps(
  overrides: Partial<EdgeProps> & { data?: Record<string, unknown> } = {},
): EdgeProps {
  return {
    id: "user:e1",
    sourceX: 0,
    sourceY: 0,
    targetX: 100,
    targetY: 100,
    sourcePosition: "right" as import("@xyflow/react").Position,
    targetPosition: "left" as import("@xyflow/react").Position,
    selected: false,
    source: "a",
    target: "b",
    data: {},
    ...overrides,
  } as EdgeProps;
}

describe("UserEdge — ラベル編集", () => {
  beforeEach(() => vi.clearAllMocks());

  it("ラベルなしのとき hit-area div が表示される", () => {
    const { container } = render(<UserEdge {...makeProps()} />);
    const hitArea = container.querySelector('[style*="cursor: text"]');
    expect(hitArea).toBeTruthy();
  });

  it("forwardLabel ありのとき label テキストが表示される", () => {
    render(<UserEdge {...makeProps({ data: { forwardLabel: "テスト" } })} />);
    expect(screen.getByText("テスト")).toBeTruthy();
  });

  it("forwardLabel と backwardLabel を両方表示する", () => {
    render(
      <UserEdge
        {...makeProps({
          data: { forwardLabel: "前向き", backwardLabel: "後ろ向き" },
        })}
      />,
    );
    expect(screen.getByText("前向き")).toBeTruthy();
    expect(screen.getByText("後ろ向き")).toBeTruthy();
  });

  it("ダブルクリックで forwardLabel の入力欄が表示される", async () => {
    render(<UserEdge {...makeProps({ data: { forwardLabel: "既存" } })} />);
    await userEvent.dblClick(screen.getByText("既存"));
    expect(screen.getByRole("textbox")).toBeTruthy();
  });

  it("Enter で onLabelSave が forwardLabel フィールドで呼ばれる", async () => {
    const onLabelSave = vi.fn();
    render(
      <UserEdge
        {...makeProps({ data: { forwardLabel: "既存", onLabelSave } })}
      />,
    );
    await userEvent.dblClick(screen.getByText("既存"));
    const input = screen.getByRole("textbox");
    await userEvent.clear(input);
    await userEvent.type(input, "新しい");
    await userEvent.keyboard("{Enter}");
    expect(onLabelSave).toHaveBeenCalledWith("forwardLabel", "新しい");
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("空文字で確定すると null が渡される", async () => {
    const onLabelSave = vi.fn();
    render(
      <UserEdge
        {...makeProps({ data: { forwardLabel: "既存", onLabelSave } })}
      />,
    );
    await userEvent.dblClick(screen.getByText("既存"));
    const input = screen.getByRole("textbox");
    await userEvent.clear(input);
    await userEvent.keyboard("{Enter}");
    expect(onLabelSave).toHaveBeenCalledWith("forwardLabel", null);
  });

  it("Escape で onLabelSave を呼ばずに編集キャンセル", async () => {
    const onLabelSave = vi.fn();
    render(
      <UserEdge
        {...makeProps({ data: { forwardLabel: "既存", onLabelSave } })}
      />,
    );
    await userEvent.dblClick(screen.getByText("既存"));
    await userEvent.keyboard("{Escape}");
    expect(onLabelSave).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});

describe("UserEdge — ラベル追加プレースホルダー", () => {
  beforeEach(() => vi.clearAllMocks());

  it("選択中はラベルなしエッジに「＋ラベル」プレースホルダーが出る", () => {
    render(<UserEdge {...makeProps({ selected: true })} />);
    expect(screen.getByText("＋ラベル")).toBeTruthy();
  });

  it("非選択のラベルなしエッジにはプレースホルダーを出さない", () => {
    render(<UserEdge {...makeProps({ selected: false })} />);
    expect(screen.queryByText("＋ラベル")).toBeNull();
  });

  it("ラベルなしエッジのプレースホルダーは1つだけ", () => {
    render(<UserEdge {...makeProps({ selected: true })} />);
    expect(screen.getAllByText("＋ラベル")).toHaveLength(1);
  });

  it("ホバーでプレースホルダーが出現する", async () => {
    const { container } = render(
      <UserEdge {...makeProps({ selected: false })} />,
    );
    const hitArea = container.querySelector('[style*="cursor: text"]');
    await userEvent.hover(hitArea!.parentElement!);
    expect(screen.getByText("＋ラベル")).toBeTruthy();
  });

  it("プレースホルダーのクリックで入力欄が開く", async () => {
    render(<UserEdge {...makeProps({ selected: true })} />);
    await userEvent.click(screen.getByText("＋ラベル"));
    expect(screen.getByRole("textbox")).toBeTruthy();
  });

  it("プレースホルダーから入力した値が forwardLabel で onLabelSave に渡る", async () => {
    const onLabelSave = vi.fn();
    render(
      <UserEdge {...makeProps({ selected: true, data: { onLabelSave } })} />,
    );
    await userEvent.click(screen.getByText("＋ラベル"));
    await userEvent.type(screen.getByRole("textbox"), "入口");
    await userEvent.keyboard("{Enter}");
    expect(onLabelSave).toHaveBeenCalledWith("forwardLabel", "入口");
  });

  it("forwardLabel があるとき選択中は backward プレースホルダーが出る", () => {
    render(
      <UserEdge
        {...makeProps({ selected: true, data: { forwardLabel: "行き" } })}
      />,
    );
    expect(screen.getByText("行き")).toBeTruthy();
    expect(screen.getByText("＋ラベル")).toBeTruthy();
  });
});
