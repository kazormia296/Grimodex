// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { StickyNode } from "./StickyNode";
import type { NodeProps } from "@xyflow/react";

vi.mock("@xyflow/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();
  return {
    ...actual,
    Handle: () => null,
    // NodeToolbar はポータルで RF viewport に描画し、store context が無い
    // happy-dom では null を返す。テストは showAdoptUI 条件と onClick の検証が
    // 目的なので children をそのまま描画するパススルーに差し替える。
    NodeToolbar: ({ children }: { children?: React.ReactNode }) => (
      <div data-testid="node-toolbar">{children}</div>
    ),
  };
});

vi.mock("@tiptap/react", () => ({
  useEditor: vi.fn().mockReturnValue({
    commands: { focus: vi.fn() },
    getJSON: vi.fn().mockReturnValue({ type: "doc", content: [] }),
    setEditable: vi.fn(),
  }),
  EditorContent: () => <div data-testid="tiptap-editor" />,
}));

vi.mock("@tiptap/core", () => ({
  generateHTML: vi.fn().mockReturnValue("<p>rendered body</p>"),
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
    paletteId: string;
    colorSlot: number;
    aiDerived: boolean;
    branchAttached: boolean;
    onAdopt: ReturnType<typeof vi.fn>;
    onReject: ReturnType<typeof vi.fn>;
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
      paletteId: "post-it-playful",
      colorSlot: 0,
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

  it("非編集時に本文の HTML が描画される", () => {
    const { container } = render(<StickyNode {...makeProps()} />);
    const view = container.querySelector('[data-testid="sticky-body-view"]');
    expect(view?.innerHTML).toBe("<p>rendered body</p>");
  });

  it("非編集時に TipTap エディタが表示されない", () => {
    render(<StickyNode {...makeProps()} />);
    expect(screen.queryByTestId("tiptap-editor")).toBeNull();
  });
});

describe("StickyNode — コピー時の Authorship 伝搬", () => {
  beforeEach(() => vi.clearAllMocks());

  const getStickyContent = (container: HTMLElement) =>
    container.querySelector('[data-testid="sticky-content"]') as HTMLElement;

  it("一律 source でスタンプする onCopy ハンドラを持たない (per-span を PM に委譲)", () => {
    // 旧実装は onCopy={handleCopyWithAttribution(e, aiDerived ? "ai" : "human")}
    // で選択全体を sticky 単位の source で塗り潰し、AI Sticky の人間編集部分まで
    // "ai" にしていた。per-span 化のため onCopy は撤去し、ProseMirror ネイティブの
    // span[data-authorship] serialization に委譲する。
    const { container } = render(
      <StickyNode {...makeProps({ aiDerived: true })} />,
    );
    const content = getStickyContent(container);
    expect(content.oncopy).toBeNull();
    expect(content.hasAttribute("data-grimodex-source")).toBe(false);
  });
});

describe("StickyNode — 採用 / 不採用 (AI Branch)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("branchAttached=true のとき採用 / 不採用ボタンを表示する", () => {
    render(
      <StickyNode {...makeProps({ branchAttached: true, aiDerived: true })} />,
    );
    expect(screen.getByLabelText("この付箋を採用")).toBeTruthy();
    expect(screen.getByLabelText("この付箋を不採用")).toBeTruthy();
  });

  it("branchAttached=false (通常 / 採用済み Sticky) ではボタンを表示しない", () => {
    render(
      <StickyNode {...makeProps({ branchAttached: false, aiDerived: true })} />,
    );
    expect(screen.queryByLabelText("この付箋を採用")).toBeNull();
    expect(screen.queryByLabelText("この付箋を不採用")).toBeNull();
  });

  it("採用ボタンクリックで onAdopt が呼ばれる", () => {
    const onAdopt = vi.fn();
    render(<StickyNode {...makeProps({ branchAttached: true, onAdopt })} />);
    fireEvent.click(screen.getByLabelText("この付箋を採用"));
    expect(onAdopt).toHaveBeenCalledTimes(1);
  });

  it("不採用ボタンクリックで onReject が呼ばれる", () => {
    const onReject = vi.fn();
    render(<StickyNode {...makeProps({ branchAttached: true, onReject })} />);
    fireEvent.click(screen.getByLabelText("この付箋を不採用"));
    expect(onReject).toHaveBeenCalledTimes(1);
  });

  it("採用済み (branchAttached=false) でも aiDerived=true なら onCopy で 'ai' を維持する想定 (provenance 保持)", () => {
    // aiDerived は branchAttached と独立。採用後 (branchAttached=false) でも
    // aiDerived=true が残るため onCopy ラベルは "ai" を維持する。ここでは
    // ボタン非表示と本文描画の両立だけを退行 gate する。
    const { container } = render(
      <StickyNode {...makeProps({ branchAttached: false, aiDerived: true })} />,
    );
    expect(
      container.querySelector('[data-testid="sticky-paper"]'),
    ).toBeTruthy();
    expect(screen.queryByLabelText("この付箋を採用")).toBeNull();
  });
});

describe("StickyNode — 編集モード", () => {
  beforeEach(() => vi.clearAllMocks());

  it("ダブルクリックで編集モードが起動する", async () => {
    const { container } = render(<StickyNode {...makeProps()} />);
    const innerDiv = container.querySelector(
      "[style*='cursor']",
    ) as HTMLElement;
    fireEvent.dblClick(innerDiv);
    expect(screen.getByTestId("tiptap-editor")).toBeTruthy();
  });

  it("編集ラッパに nodrag が付き、クリックでのカーソル移動が xyflow drag に奪われない", () => {
    // xyflow の d3-drag が pointerdown を preventDefault するとキャレット移動が
    // ブロックされる。nodrag クラスで drag filter がこの領域を除外する。
    // (happy-dom では d3-drag は走らないためクラス存在を退行 gate として検証)
    const { container } = render(<StickyNode {...makeProps()} />);
    const innerDiv = container.querySelector(
      "[style*='cursor']",
    ) as HTMLElement;
    fireEvent.dblClick(innerDiv);
    const wrapper = container.querySelector(".sticky-editor") as HTMLElement;
    expect(wrapper).toBeTruthy();
    expect(wrapper.classList.contains("nodrag")).toBe(true);
  });

  it("Escape キーで編集が終了する", async () => {
    const { container } = render(<StickyNode {...makeProps()} />);
    const innerDiv = container.querySelector(
      "[style*='cursor']",
    ) as HTMLElement;
    fireEvent.dblClick(innerDiv);
    const editor = screen.getByTestId("tiptap-editor");
    fireEvent.keyDown(editor, { key: "Escape" });
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

  it("--sticky-bg-light 変数が paletteId/colorSlot から解決される", () => {
    // post-it-playful slot 4 = Blue Paradise #2A8FBD
    const { container } = render(
      <StickyNode {...makeProps({ colorSlot: 4 })} />,
    );
    const paper = container.querySelector(
      '[data-testid="sticky-paper"]',
    ) as HTMLElement;
    expect(paper?.style.getPropertyValue("--sticky-bg-light")).toBe("#2A8FBD");
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

  it("data.rotation が sticky-paper-wrap の transform style に反映される", () => {
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
    const wrap = container.querySelector(
      '[data-testid="sticky-paper-wrap"]',
    ) as HTMLElement;
    expect(wrap?.style.transform).toContain("rotate(2.1deg)");
  });

  it("data.rotation が未指定のとき sticky-paper-wrap の transform は rotate(0deg)", () => {
    const { container } = render(<StickyNode {...makeProps()} />);
    const wrap = container.querySelector(
      '[data-testid="sticky-paper-wrap"]',
    ) as HTMLElement;
    expect(wrap?.style.transform).toContain("rotate(0deg)");
  });
});

// ────────────────────────────────────────────────────────────────
// Phase 3: enter アニメ
// ────────────────────────────────────────────────────────────────
// motion/react mock — captures onAnimationComplete for Phase 4 tests
let capturedOnAnimationComplete: ((definition: string) => void) | undefined;

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
        onAnimationComplete,
        "data-testid": testId,
        ...rest
      }: React.HTMLAttributes<HTMLDivElement> & {
        initial?: unknown;
        animate?: unknown;
        "data-testid"?: string;
        onAnimationComplete?: (definition: string) => void;
      }) => {
        capturedOnAnimationComplete = onAnimationComplete;
        return (
          <div
            data-testid={testId}
            data-motion-initial={JSON.stringify(initial)}
            data-motion-animate={JSON.stringify(animate)}
            {...rest}
          >
            {children}
          </div>
        );
      },
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

// ────────────────────────────────────────────────────────────────
// Phase 4: exit アニメ + 2-phase delete
// ────────────────────────────────────────────────────────────────
describe("StickyNode — exit アニメ (Phase 4)", () => {
  beforeEach(() => {
    capturedOnAnimationComplete = undefined;
    vi.clearAllMocks();
  });

  it("isDeleting=true のとき animate は exit variant (opacity:0)", () => {
    const { container } = render(
      <StickyNode
        {...makeProps()}
        data={
          {
            ...(makeProps().data as object),
            isDeleting: true,
          } as NodeProps["data"]
        }
      />,
    );
    const wrapper = container.querySelector('[data-testid="sticky-motion"]');
    const animate = JSON.parse(
      wrapper?.getAttribute("data-motion-animate") ?? "{}",
    );
    expect(animate.opacity).toBe(0);
  });

  it("isDeleting=false のとき animate は enter variant (opacity:1)", () => {
    const { container } = render(
      <StickyNode
        {...makeProps()}
        data={
          {
            ...(makeProps().data as object),
            isDeleting: false,
          } as NodeProps["data"]
        }
      />,
    );
    const wrapper = container.querySelector('[data-testid="sticky-motion"]');
    const animate = JSON.parse(
      wrapper?.getAttribute("data-motion-animate") ?? "{}",
    );
    expect(animate.opacity).toBe(1);
  });

  it("onAnimationComplete('exit') で onExitComplete(id) が呼ばれる", () => {
    const onExitComplete = vi.fn();
    render(
      <StickyNode
        {...makeProps()}
        data={
          {
            ...(makeProps().data as object),
            isDeleting: true,
            onExitComplete,
          } as NodeProps["data"]
        }
      />,
    );

    act(() => {
      capturedOnAnimationComplete?.("exit");
    });

    expect(onExitComplete).toHaveBeenCalledWith("test-1");
  });

  it("onAnimationComplete('animate') では onExitComplete は呼ばれない", () => {
    const onExitComplete = vi.fn();
    render(
      <StickyNode
        {...makeProps()}
        data={
          {
            ...(makeProps().data as object),
            isDeleting: false,
            onExitComplete,
          } as NodeProps["data"]
        }
      />,
    );

    act(() => {
      capturedOnAnimationComplete?.("animate");
    });

    expect(onExitComplete).not.toHaveBeenCalled();
  });
});
