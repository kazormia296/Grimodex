// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
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
  pendingAutoFocusIds: new Set<string>(),
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

// ────────────────────────────────────────────────────────────────
// Phase 1: Post-It スキューモフィズムデザイン
// ────────────────────────────────────────────────────────────────
describe("StickyNode — Post-It デザイン (Phase 1)", () => {
  let originalResizeObserver: typeof ResizeObserver;

  beforeEach(() => {
    originalResizeObserver = globalThis.ResizeObserver;
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.ResizeObserver = originalResizeObserver;
  });

  it("sticky-paper 要素が描画される", () => {
    const { container } = render(<StickyNode {...makeProps()} />);
    expect(
      container.querySelector('[data-testid="sticky-paper"]'),
    ).toBeTruthy();
  });

  it("data-color 属性が color prop に対応する", () => {
    const { container } = render(
      <StickyNode {...makeProps({ color: "blue" })} />,
    );
    const paper = container.querySelector('[data-testid="sticky-paper"]');
    expect(paper?.getAttribute("data-color")).toBe("blue");
  });

  it("data-glue の初期値は left", () => {
    const { container } = render(<StickyNode {...makeProps()} />);
    const paper = container.querySelector('[data-testid="sticky-paper"]');
    expect(paper?.getAttribute("data-glue")).toBe("left");
  });

  it("ResizeObserver が height >= 110 を報告すると data-glue が top に切替わる", () => {
    let roCallback: ResizeObserverCallback | undefined;
    class MockResizeObserver {
      constructor(cb: ResizeObserverCallback) {
        roCallback = cb;
      }
      observe = vi.fn();
      disconnect = vi.fn();
    }
    vi.stubGlobal("ResizeObserver", MockResizeObserver);

    const { container } = render(<StickyNode {...makeProps()} />);

    act(() => {
      roCallback?.(
        [{ contentRect: { height: 115 } } as ResizeObserverEntry],
        {} as ResizeObserver,
      );
    });

    const paper = container.querySelector('[data-testid="sticky-paper"]');
    expect(paper?.getAttribute("data-glue")).toBe("top");
  });

  it("ResizeObserver height が 90 以下に戻ると data-glue が left に戻る（ヒステリシス）", () => {
    let roCallback: ResizeObserverCallback | undefined;
    class MockResizeObserver {
      constructor(cb: ResizeObserverCallback) {
        roCallback = cb;
      }
      observe = vi.fn();
      disconnect = vi.fn();
    }
    vi.stubGlobal("ResizeObserver", MockResizeObserver);

    const { container } = render(<StickyNode {...makeProps()} />);

    // top に切替
    act(() => {
      roCallback?.(
        [{ contentRect: { height: 115 } } as ResizeObserverEntry],
        {} as ResizeObserver,
      );
    });
    expect(
      container
        .querySelector('[data-testid="sticky-paper"]')
        ?.getAttribute("data-glue"),
    ).toBe("top");

    // left に戻す (90 以下)
    act(() => {
      roCallback?.(
        [{ contentRect: { height: 85 } } as ResizeObserverEntry],
        {} as ResizeObserver,
      );
    });
    expect(
      container
        .querySelector('[data-testid="sticky-paper"]')
        ?.getAttribute("data-glue"),
    ).toBe("left");
  });

  it("height が 91–109 の範囲では切替わらない（ヒステリシスのデッドバンド）", () => {
    let roCallback: ResizeObserverCallback | undefined;
    class MockResizeObserver {
      constructor(cb: ResizeObserverCallback) {
        roCallback = cb;
      }
      observe = vi.fn();
      disconnect = vi.fn();
    }
    vi.stubGlobal("ResizeObserver", MockResizeObserver);

    const { container } = render(<StickyNode {...makeProps()} />);

    act(() => {
      roCallback?.(
        [{ contentRect: { height: 100 } } as ResizeObserverEntry],
        {} as ResizeObserver,
      );
    });

    expect(
      container
        .querySelector('[data-testid="sticky-paper"]')
        ?.getAttribute("data-glue"),
    ).toBe("left");
  });

  it("data.rotation が paper の transform style に反映される", () => {
    const { container } = render(
      <StickyNode
        {...makeProps()}
        data={
          {
            ...(makeProps().data as object),
            rotation: 2.1,
          } as NodeProps["data"]
        }
      />,
    );
    const paper = container.querySelector(
      '[data-testid="sticky-paper"]',
    ) as HTMLElement;
    expect(paper?.style.transform).toContain("rotate(2.1deg)");
  });

  it("data.rotation が未指定のとき transform は rotate(0deg)", () => {
    const { container } = render(<StickyNode {...makeProps()} />);
    const paper = container.querySelector(
      '[data-testid="sticky-paper"]',
    ) as HTMLElement;
    expect(paper?.style.transform).toContain("rotate(0deg)");
  });
});

// ────────────────────────────────────────────────────────────────
// Phase 2: 折れ角 (isOld)
// ────────────────────────────────────────────────────────────────
describe("StickyNode — 折れ角 (Phase 2)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("isOld=false のとき sticky-corner は非表示（display:none CSS に委ねる）", () => {
    const { container } = render(
      <StickyNode
        {...makeProps()}
        data={
          { ...(makeProps().data as object), isOld: false } as NodeProps["data"]
        }
      />,
    );
    const corner = container.querySelector(".sticky-corner");
    expect(corner).toBeTruthy();
    expect(corner?.getAttribute("aria-hidden")).toBe("true");
  });

  it("isOld=true のとき sticky-paper に data-old='true' が付く", () => {
    const { container } = render(
      <StickyNode
        {...makeProps()}
        data={
          { ...(makeProps().data as object), isOld: true } as NodeProps["data"]
        }
      />,
    );
    const paper = container.querySelector('[data-testid="sticky-paper"]');
    expect(paper?.getAttribute("data-old")).toBe("true");
  });

  it("isOld=false のとき data-old='false' が付く", () => {
    const { container } = render(
      <StickyNode
        {...makeProps()}
        data={
          { ...(makeProps().data as object), isOld: false } as NodeProps["data"]
        }
      />,
    );
    const paper = container.querySelector('[data-testid="sticky-paper"]');
    expect(paper?.getAttribute("data-old")).toBe("false");
  });
});

// ────────────────────────────────────────────────────────────────
// Phase 3: enter アニメ
// ────────────────────────────────────────────────────────────────
vi.mock("motion/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("motion/react")>();
  return {
    ...actual,
    motion: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(actual.motion as any),
      div: ({
        children,
        initial,
        animate,
        "data-testid": testId,
        ...rest
      }: React.HTMLAttributes<HTMLDivElement> & {
        initial?: unknown;
        animate?: unknown;
        "data-testid"?: string;
      }) => (
        <div
          data-testid={testId}
          data-motion-initial={JSON.stringify(initial)}
          data-motion-animate={JSON.stringify(animate)}
          {...rest}
        >
          {children}
        </div>
      ),
    },
  };
});

describe("StickyNode — enter アニメ (Phase 3)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("motion-wrapper が描画される", () => {
    const { container } = render(<StickyNode {...makeProps()} />);
    expect(
      container.querySelector('[data-testid="sticky-motion"]'),
    ).toBeTruthy();
  });

  it("initial が opacity:0 を含む", () => {
    const { container } = render(<StickyNode {...makeProps()} />);
    const wrapper = container.querySelector('[data-testid="sticky-motion"]');
    const initial = JSON.parse(
      wrapper?.getAttribute("data-motion-initial") ?? "{}",
    );
    expect(initial.opacity).toBe(0);
  });

  it("animate が opacity:1 を含む", () => {
    const { container } = render(<StickyNode {...makeProps()} />);
    const wrapper = container.querySelector('[data-testid="sticky-motion"]');
    const animate = JSON.parse(
      wrapper?.getAttribute("data-motion-animate") ?? "{}",
    );
    expect(animate.opacity).toBe(1);
  });
});
