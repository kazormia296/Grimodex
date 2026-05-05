// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StickyNode } from "./StickyNode";
import type { NodeProps } from "@xyflow/react";

vi.mock("@xyflow/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();
  return {
    ...actual,
    Handle: () => null,
  };
});

vi.mock("@tiptap/react", () => ({
  useEditor: vi.fn().mockReturnValue({
    commands: { focus: vi.fn() },
    getJSON: vi.fn().mockReturnValue({ type: "doc", content: [] }),
  }),
  EditorContent: () => <div data-testid="tiptap-editor" />,
}));

vi.mock("@/features/editor/extensions", () => ({
  getStickyEditorExtensions: vi.fn().mockReturnValue([]),
}));

vi.mock("../mapApi", () => ({
  updateSticky: vi.fn().mockResolvedValue(undefined),
  extractPreviewText: vi.fn().mockReturnValue("preview text"),
}));

function makeProps(
  overrides: Partial<{
    id: string;
    title: string;
    body: string;
    previewText: string;
    color: string;
    useTipTap: boolean;
    onUpdate: ReturnType<typeof vi.fn>;
  }> = {},
): NodeProps {
  return {
    id: "sticky:test-1",
    selected: false,
    data: {
      id: "test-1",
      title: "テストタイトル",
      body: '{"type":"doc","content":[]}',
      previewText: "preview text",
      color: "yellow",
      useTipTap: true,
      ...overrides,
    },
    type: "sticky",
    xPos: 0,
    yPos: 0,
    zIndex: 0,
    isConnectable: true,
    dragging: false,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
  } as unknown as NodeProps;
}

describe("StickyNode — 表示", () => {
  beforeEach(() => vi.clearAllMocks());

  it("previewText が表示される", () => {
    render(<StickyNode {...makeProps({ previewText: "本文プレビュー" })} />);
    expect(screen.getByText("本文プレビュー")).toBeTruthy();
  });

  it("title が input に表示される", () => {
    render(<StickyNode {...makeProps({ title: "テスト" })} />);
    const input = screen.getByPlaceholderText("タイトル") as HTMLInputElement;
    expect(input.value).toBe("テスト");
  });

  it("非編集時に TipTap エディタが表示されない", () => {
    render(<StickyNode {...makeProps()} />);
    expect(screen.queryByTestId("tiptap-editor")).toBeNull();
  });
});

describe("StickyNode — 編集モード", () => {
  beforeEach(() => vi.clearAllMocks());

  it("ダブルクリックで編集モードが起動する（useTipTap=true）", async () => {
    const { container } = render(<StickyNode {...makeProps()} />);
    const innerDiv = container.querySelector(
      "[style*='cursor']",
    ) as HTMLElement;
    fireEvent.dblClick(innerDiv);
    expect(screen.getByTestId("tiptap-editor")).toBeTruthy();
  });

  it("useTipTap=false のとき静的表示のまま（編集モードに入らない）", () => {
    const { container } = render(
      <StickyNode {...makeProps({ useTipTap: false })} />,
    );
    const innerDiv = container.querySelector(
      "[style*='cursor']",
    ) as HTMLElement;
    fireEvent.dblClick(innerDiv);
    expect(screen.queryByTestId("tiptap-editor")).toBeNull();
  });

  it("Escape キーで編集が終了する", async () => {
    const { container } = render(<StickyNode {...makeProps()} />);
    const innerDiv = container.querySelector(
      "[style*='cursor']",
    ) as HTMLElement;
    fireEvent.dblClick(innerDiv);
    expect(screen.getByTestId("tiptap-editor")).toBeTruthy();

    const titleInput = screen.getByPlaceholderText("タイトル");
    await userEvent.type(titleInput, "{Escape}");
    expect(screen.queryByTestId("tiptap-editor")).toBeNull();
  });
});

describe("StickyNode — カラー変更", () => {
  beforeEach(() => vi.clearAllMocks());

  it("カラーボタンをクリックするとパレットが表示される", async () => {
    render(<StickyNode {...makeProps()} />);
    const colorBtn = screen.getByTitle("色を変更");
    await userEvent.click(colorBtn);
    expect(screen.getByTitle("pink")).toBeTruthy();
  });

  it("色を選択すると onUpdate が呼ばれる", async () => {
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    render(<StickyNode {...makeProps({ onUpdate })} />);
    const colorBtn = screen.getByTitle("色を変更");
    await userEvent.click(colorBtn);
    await userEvent.click(screen.getByTitle("pink"));
    expect(onUpdate).toHaveBeenCalledWith({ color: "pink" });
  });
});

describe("StickyNode — 50 閾値フォールバック", () => {
  it("useTipTap=false のとき静的 HTML プレビューを表示する", () => {
    render(
      <StickyNode
        {...makeProps({ useTipTap: false, previewText: "静的プレビュー" })}
      />,
    );
    expect(screen.getByText("静的プレビュー")).toBeTruthy();
    expect(screen.queryByTestId("tiptap-editor")).toBeNull();
  });
});
