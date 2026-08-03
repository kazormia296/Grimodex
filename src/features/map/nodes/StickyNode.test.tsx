// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { StickyNode } from "./StickyNode";
import type { NodeProps } from "@xyflow/react";
import {
  _resetQuiescenceParticipantsForTests,
  collectQuiescenceParticipantRecovery,
  flushQuiescenceParticipants,
} from "@/application/lifecycle/quiescenceParticipants";
import {
  _resetQuiescenceLeasesForTests,
  acquireQuiescenceLease,
} from "@/application/lifecycle/quiescenceLease";

const mockToastError = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({
  toast: { error: mockToastError },
}));

vi.mock("@xyflow/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();
  return {
    ...actual,
    Handle: () => null,
    // NodeToolbar はポータルで RF viewport に描画し、store context が無い
    // happy-dom では null を返す。テストは showAdoptUI 条件と onClick の検証が
    // 目的なので children をそのまま描画するパススルーに差し替える。
    NodeToolbar: ({
      children,
      isVisible,
    }: {
      children?: React.ReactNode;
      isVisible?: boolean;
    }) => (
      <div data-testid="node-toolbar" data-visible={String(isVisible)}>
        {children}
      </div>
    ),
  };
});

const tiptapMock = vi.hoisted(() => ({
  onUpdate: undefined as
    | ((event: { editor: { getJSON: () => object } }) => void)
    | undefined,
  json: { type: "doc", content: [] } as object,
}));

vi.mock("@tiptap/react", () => ({
  useEditor: vi
    .fn()
    .mockImplementation(
      (options: {
        onUpdate?: (event: { editor: { getJSON: () => object } }) => void;
      }) => {
        tiptapMock.onUpdate = options.onUpdate;
        return {
          commands: { focus: vi.fn() },
          getJSON: vi.fn(() => tiptapMock.json),
          setEditable: vi.fn(),
        };
      },
    ),
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

afterEach(() => {
  _resetQuiescenceLeasesForTests();
  _resetQuiescenceParticipantsForTests();
});

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

  it("右クリックメニューからキーボード操作可能な採用 / 不採用項目を開ける", async () => {
    const onAdopt = vi.fn();
    const onReject = vi.fn();
    const { container } = render(
      <StickyNode
        {...makeProps({ branchAttached: true, onAdopt, onReject })}
      />,
    );

    fireEvent.contextMenu(container.firstElementChild as HTMLElement);

    const adoptItem = await screen.findByRole("menuitem", { name: "採用" });
    expect(screen.getByRole("menuitem", { name: "不採用" })).toBeTruthy();
    fireEvent.click(adoptItem);
    expect(onAdopt).toHaveBeenCalledTimes(1);
    expect(onReject).not.toHaveBeenCalled();
  });

  it("branch 専用メニューは親 ReactFlow の context menu を同時に開かない", async () => {
    const parentContextMenu = vi.fn();
    render(
      <div onContextMenu={parentContextMenu}>
        <StickyNode
          {...makeProps({
            branchAttached: true,
            onAdopt: vi.fn(),
            onReject: vi.fn(),
          })}
        />
      </div>,
    );

    fireEvent.contextMenu(screen.getByTestId("sticky-paper"));

    expect(
      await screen.findByRole("menuitem", { name: "採用" }),
    ).toBeInTheDocument();
    expect(parentContextMenu).not.toHaveBeenCalled();
  });

  it("通常 Sticky は既存の親 ReactFlow context menu へ伝播する", () => {
    const parentContextMenu = vi.fn();
    render(
      <div onContextMenu={parentContextMenu}>
        <StickyNode
          {...makeProps({
            branchAttached: false,
          })}
        />
      </div>,
    );

    fireEvent.contextMenu(screen.getByTestId("sticky-paper"));

    expect(parentContextMenu).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menuitem", { name: "採用" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "不採用" })).toBeNull();
  });

  it("selected 状態でtoolbarを表示する", () => {
    const props = makeProps({ branchAttached: true });
    const { rerender } = render(<StickyNode {...props} />);
    expect(screen.getByTestId("node-toolbar").dataset.visible).toBe("false");

    rerender(<StickyNode {...props} selected />);
    expect(screen.getByTestId("node-toolbar").dataset.visible).toBe("true");
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
  beforeEach(() => {
    vi.clearAllMocks();
    tiptapMock.onUpdate = undefined;
    tiptapMock.json = { type: "doc", content: [] };
  });

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
    await vi.waitFor(() =>
      expect(screen.queryByTestId("tiptap-editor")).toBeNull(),
    );
  });

  it("lease取得後は編集開始を拒否し、解放後に再開できる", () => {
    const { container } = render(<StickyNode {...makeProps()} />);
    const innerDiv = container.querySelector(
      "[style*='cursor']",
    ) as HTMLElement;
    let lease!: ReturnType<typeof acquireQuiescenceLease>;
    act(() => {
      lease = acquireQuiescenceLease("workspace-open");
    });

    fireEvent.dblClick(innerDiv);
    expect(screen.queryByTestId("tiptap-editor")).toBeNull();
    expect(
      container.querySelector("[data-quiescence-locked='true']"),
    ).toBeTruthy();

    act(() => lease.release());
    fireEvent.dblClick(innerDiv);
    expect(screen.getByTestId("tiptap-editor")).toBeTruthy();
  });

  it("participant flush中に交差した更新を拒否し、前半flush後に再dirty化しない", async () => {
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const onUpdate = vi.fn(() => writeGate);
    const { container } = render(<StickyNode {...makeProps({ onUpdate })} />);
    const innerDiv = container.querySelector(
      "[style*='cursor']",
    ) as HTMLElement;
    fireEvent.dblClick(innerDiv);

    const firstJson = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "A" }] }],
    };
    tiptapMock.json = firstJson;
    act(() => {
      tiptapMock.onUpdate?.({
        editor: { getJSON: () => tiptapMock.json },
      });
    });

    let lease!: ReturnType<typeof acquireQuiescenceLease>;
    act(() => {
      lease = acquireQuiescenceLease("project-load");
    });
    const flushing = flushQuiescenceParticipants();
    await vi.waitFor(() => expect(onUpdate).toHaveBeenCalledOnce());

    // This callback can already be queued by TipTap before read-only is
    // applied. The synchronous lease gate must still reject it.
    tiptapMock.json = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "late B" }] },
      ],
    };
    act(() => {
      tiptapMock.onUpdate?.({
        editor: { getJSON: () => tiptapMock.json },
      });
    });

    releaseWrite();
    await flushing;
    act(() => lease.release());
    await flushQuiescenceParticipants();

    expect(onUpdate).toHaveBeenCalledOnce();
    expect(onUpdate).toHaveBeenCalledWith({
      body: JSON.stringify(firstJson),
      previewText: "preview text",
    });
  });

  it("同じ Sticky id の data object 更新で participant を重複登録しない", async () => {
    const save = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const firstProps = makeProps({ onUpdate: save });
    const { container, rerender } = render(<StickyNode {...firstProps} />);
    fireEvent.dblClick(
      container.querySelector("[style*='cursor']") as HTMLElement,
    );
    tiptapMock.json = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "same id draft" }],
        },
      ],
    };
    act(() => {
      tiptapMock.onUpdate?.({
        editor: { getJSON: () => tiptapMock.json },
      });
    });

    rerender(
      <StickyNode
        {...makeProps({
          title: "parent rerender",
          onUpdate: save,
        })}
      />,
    );
    await flushQuiescenceParticipants();

    expect(save).toHaveBeenCalledOnce();
  });

  it("flush失敗後のcancel/releaseでdirty editorを再開し、同じdraftを保存できる", async () => {
    const save = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValueOnce(undefined);
    const { container } = render(
      <StickyNode {...makeProps({ onUpdate: save })} />,
    );
    const innerDiv = container.querySelector(
      "[style*='cursor']",
    ) as HTMLElement;
    fireEvent.dblClick(innerDiv);

    const dirtyJson = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "unsaved draft" }],
        },
      ],
    };
    tiptapMock.json = dirtyJson;
    act(() => {
      tiptapMock.onUpdate?.({
        editor: { getJSON: () => tiptapMock.json },
      });
    });

    let lease!: ReturnType<typeof acquireQuiescenceLease>;
    act(() => {
      lease = acquireQuiescenceLease("window-close");
    });
    // The draft editor stays mounted but is made read-only by the shared
    // editable hook. A failed flush must not replace it with stale d.body.
    expect(screen.getByTestId("tiptap-editor")).toBeTruthy();
    await expect(flushQuiescenceParticipants()).rejects.toThrow(
      "failed to flush",
    );
    expect(save).toHaveBeenCalledOnce();

    // Simulate cancelling the destructive lifecycle after its failure dialog.
    act(() => lease.release());
    const editor = screen.getByTestId("tiptap-editor");
    expect(editor).toBeTruthy();

    fireEvent.keyDown(editor, { key: "Escape" });
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save).toHaveBeenLastCalledWith({
      body: JSON.stringify(dirtyJson),
      previewText: "preview text",
    });
    await vi.waitFor(() =>
      expect(screen.queryByTestId("tiptap-editor")).toBeNull(),
    );
  });

  it("Escape 保存失敗では editor/recovery を保持し、次の Escape で再試行できる", async () => {
    const save = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValueOnce(undefined);
    const { container } = render(
      <StickyNode {...makeProps({ onUpdate: save })} />,
    );
    fireEvent.dblClick(
      container.querySelector("[style*='cursor']") as HTMLElement,
    );

    const dirtyJson = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "retryable draft" }],
        },
      ],
    };
    tiptapMock.json = dirtyJson;
    act(() => {
      tiptapMock.onUpdate?.({
        editor: { getJSON: () => tiptapMock.json },
      });
    });

    fireEvent.keyDown(screen.getByTestId("tiptap-editor"), { key: "Escape" });
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());

    expect(screen.getByTestId("tiptap-editor")).toBeTruthy();
    await vi.waitFor(() => expect(mockToastError).toHaveBeenCalledOnce());
    expect(collectQuiescenceParticipantRecovery()).toEqual([
      {
        kind: "map-sticky",
        id: "test-1",
        prosemirror: JSON.stringify(dirtyJson),
      },
    ]);

    fireEvent.keyDown(screen.getByTestId("tiptap-editor"), { key: "Escape" });
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(screen.queryByTestId("tiptap-editor")).toBeNull(),
    );
    expect(collectQuiescenceParticipantRecovery()).toEqual([]);
  });

  it("click-away 保存失敗も未処理 rejection にせず、次の click-away で再試行できる", async () => {
    const save = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValueOnce(undefined);
    const { container } = render(
      <StickyNode {...makeProps({ onUpdate: save })} />,
    );
    fireEvent.dblClick(
      container.querySelector("[style*='cursor']") as HTMLElement,
    );
    tiptapMock.json = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "click-away draft" }],
        },
      ],
    };
    act(() => {
      tiptapMock.onUpdate?.({
        editor: { getJSON: () => tiptapMock.json },
      });
    });

    fireEvent.pointerDown(document.body);
    await vi.waitFor(() => expect(mockToastError).toHaveBeenCalledOnce());
    expect(screen.getByTestId("tiptap-editor")).toBeTruthy();
    expect(collectQuiescenceParticipantRecovery()).toHaveLength(1);

    fireEvent.pointerDown(document.body);
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(screen.queryByTestId("tiptap-editor")).toBeNull(),
    );
    expect(collectQuiescenceParticipantRecovery()).toEqual([]);
  });

  it("unmount 保存失敗後も detached participant/recovery を保持し、quiesce で再試行する", async () => {
    const save = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValueOnce(undefined);
    const { container, unmount } = render(
      <StickyNode {...makeProps({ onUpdate: save })} />,
    );
    fireEvent.dblClick(
      container.querySelector("[style*='cursor']") as HTMLElement,
    );

    const dirtyJson = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "detached draft" }],
        },
      ],
    };
    tiptapMock.json = dirtyJson;
    act(() => {
      tiptapMock.onUpdate?.({
        editor: { getJSON: () => tiptapMock.json },
      });
    });

    unmount();
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(collectQuiescenceParticipantRecovery()).toEqual([
      {
        kind: "map-sticky",
        id: "test-1",
        prosemirror: JSON.stringify(dirtyJson),
      },
    ]);

    await expect(flushQuiescenceParticipants()).resolves.toBeUndefined();
    expect(save).toHaveBeenCalledTimes(2);
    expect(collectQuiescenceParticipantRecovery()).toEqual([]);

    await flushQuiescenceParticipants();
    expect(save).toHaveBeenCalledTimes(2);
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

  it("isDeleting=true のとき保存準備後の animate は exit variant (opacity:0)", async () => {
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
    await vi.waitFor(() =>
      expect(
        JSON.parse(wrapper?.getAttribute("data-motion-animate") ?? "{}")
          .opacity,
      ).toBe(0),
    );
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

  it("onAnimationComplete('exit') で onExitComplete(id) が呼ばれる", async () => {
    const onExitComplete = vi.fn();
    const { container } = render(
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
    const wrapper = container.querySelector('[data-testid="sticky-motion"]');
    await vi.waitFor(() =>
      expect(
        JSON.parse(wrapper?.getAttribute("data-motion-animate") ?? "{}")
          .opacity,
      ).toBe(0),
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

  it("削除中の保存失敗では exit/delete completion を止め、再試行成功後だけ許可する", async () => {
    const save = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValueOnce(undefined);
    const onExitComplete = vi.fn();
    const initialProps = makeProps({ onUpdate: save });
    const { container, rerender } = render(<StickyNode {...initialProps} />);
    fireEvent.dblClick(
      container.querySelector("[style*='cursor']") as HTMLElement,
    );

    const dirtyJson = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "delete retry draft" }],
        },
      ],
    };
    tiptapMock.json = dirtyJson;
    act(() => {
      tiptapMock.onUpdate?.({
        editor: { getJSON: () => tiptapMock.json },
      });
    });

    rerender(
      <StickyNode
        {...initialProps}
        data={
          {
            ...(initialProps.data as object),
            isDeleting: true,
            onExitComplete,
          } as NodeProps["data"]
        }
      />,
    );
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(mockToastError).toHaveBeenCalledOnce());

    const wrapper = container.querySelector('[data-testid="sticky-motion"]');
    expect(
      JSON.parse(wrapper?.getAttribute("data-motion-animate") ?? "{}").opacity,
    ).toBe(1);
    expect(screen.getByTestId("tiptap-editor")).toBeTruthy();
    act(() => capturedOnAnimationComplete?.("exit"));
    expect(onExitComplete).not.toHaveBeenCalled();
    expect(collectQuiescenceParticipantRecovery()).toHaveLength(1);

    fireEvent.keyDown(screen.getByTestId("tiptap-editor"), { key: "Escape" });
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(
        JSON.parse(wrapper?.getAttribute("data-motion-animate") ?? "{}")
          .opacity,
      ).toBe(0),
    );
    act(() => capturedOnAnimationComplete?.("exit"));
    expect(onExitComplete).toHaveBeenCalledWith("test-1");
    expect(collectQuiescenceParticipantRecovery()).toEqual([]);
  });
});
