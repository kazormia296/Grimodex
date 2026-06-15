// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ChatPanelHeader } from "./ChatPanelHeader";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));
// セレクタ式の Zustand フックを最小スタブ化。
vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: (sel: (s: { nodes: unknown[] }) => unknown) =>
    sel({ nodes: [] }),
}));
// activePresetId はテストから書き換え可能にする（scopeHint の遷移検証用）。
// stub なので変更後は rerender で反映する。
let mockActivePresetId: string | null = null;
vi.mock("@/features/layout/layoutStore", () => ({
  useLayoutStore: (sel: (s: { activePresetId: string | null }) => unknown) =>
    sel({ activePresetId: mockActivePresetId }),
}));

const mockCodexEntries = [
  {
    id: "c1",
    name: "Alice",
    type: "character",
    aliases: null,
  },
];
vi.mock("@/features/codex/codexStore", () => ({
  useCodexStore: (sel: (s: { entries: unknown[] }) => unknown) =>
    sel({ entries: mockCodexEntries }),
}));

const mockSnippets = [
  {
    id: "s1",
    projectId: "proj-1",
    title: "Snip A",
    content: "{}",
    tagsCache: null,
    contentSource: null,
    sceneId: null,
    sourceChatMessageId: null,
    usageCount: 0,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  },
];
vi.mock("@/features/snippets/snippetStore", () => ({
  useSnippetStore: Object.assign(
    (sel: (s: Record<string, unknown>) => unknown) =>
      sel({ entries: mockSnippets, ensureEntriesLoaded: vi.fn() }),
    {
      getState: () => ({
        entries: mockSnippets,
        ensureEntriesLoaded: vi.fn(),
      }),
    },
  ),
}));

type Props = React.ComponentProps<typeof ChatPanelHeader>;

function baseProps(over: Partial<Props> = {}): Props {
  return {
    sessionsPanelOpen: false,
    setSessionsPanelOpen: vi.fn(),
    chatScope: "project",
    scopeAnchorId: null,
    chatSceneId: "",
    editorActiveSceneId: "",
    onScopeChange: vi.fn(),
    onSelectScene: vi.fn(),
    onNewSession: vi.fn(),
    includeBodies: false,
    onToggleIncludeBodies: vi.fn(),
    includeMapBoard: false,
    mapBoardTitle: null,
    mapDisabled: false,
    onToggleIncludeMapBoard: vi.fn(),
    ragEnabled: false,
    ragDisabled: false,
    onToggleRag: vi.fn(),
    ...over,
  };
}

describe("ChatPanelHeader — scope hint on chat-main preset transition", () => {
  beforeEach(() => {
    mockActivePresetId = null;
  });

  it("shows the hint when activePresetId transitions to chat-main without remount", () => {
    // LayoutShell のプリセット切替 remount 廃止後は、パネルが生き残ったまま
    // activePresetId だけが変わる。mount effect 依存だと出なくなる退行の gate。
    const { rerender } = render(
      <ChatPanelHeader {...baseProps({ chatScope: "scene" })} />,
    );
    expect(screen.queryByText("chat.scopeHint.message")).toBeNull();

    mockActivePresetId = "builtin:chat-main";
    rerender(<ChatPanelHeader {...baseProps({ chatScope: "scene" })} />);

    expect(screen.getByText("chat.scopeHint.message")).toBeInTheDocument();
  });

  it("shows the hint on mount when chat-main is already active", () => {
    mockActivePresetId = "builtin:chat-main";
    render(<ChatPanelHeader {...baseProps({ chatScope: "scene" })} />);
    expect(screen.getByText("chat.scopeHint.message")).toBeInTheDocument();
  });

  it("does not show the hint when scope is already project", () => {
    const { rerender } = render(
      <ChatPanelHeader {...baseProps({ chatScope: "project" })} />,
    );
    mockActivePresetId = "builtin:chat-main";
    rerender(<ChatPanelHeader {...baseProps({ chatScope: "project" })} />);
    expect(screen.queryByText("chat.scopeHint.message")).toBeNull();
  });

  it("hides the hint when switching away from chat-main", () => {
    const { rerender } = render(
      <ChatPanelHeader {...baseProps({ chatScope: "scene" })} />,
    );
    mockActivePresetId = "builtin:chat-main";
    rerender(<ChatPanelHeader {...baseProps({ chatScope: "scene" })} />);
    expect(screen.getByText("chat.scopeHint.message")).toBeInTheDocument();

    mockActivePresetId = "builtin:default";
    rerender(<ChatPanelHeader {...baseProps({ chatScope: "scene" })} />);
    expect(screen.queryByText("chat.scopeHint.message")).toBeNull();
  });
});

describe("ChatPanelHeader — scope dropdown tabs (Spotlight 形式)", () => {
  function openDropdown() {
    fireEvent.click(screen.getByRole("button", { name: "chat.scope.picker" }));
  }

  it("opens with a Scene/Codex/Snippet tablist, Scene tab active for tree scopes", () => {
    render(<ChatPanelHeader {...baseProps({ chatScope: "scene" })} />);
    openDropdown();

    expect(screen.getByRole("tablist")).toBeInTheDocument();
    const sceneTab = screen.getByRole("tab", { name: "chat.scope.tabScene" });
    expect(
      screen.getByRole("tab", { name: "chat.scope.tabCodex" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("tab", { name: "chat.scope.tabSnippet" }),
    ).toBeInTheDocument();
    expect(sceneTab.getAttribute("aria-selected")).toBe("true");

    // Scene タブには Project スコープボタンが含まれる
    expect(
      screen.getByRole("button", { name: /chat\.scope\.project/ }),
    ).toBeInTheDocument();
  });

  it("Codex tab lists codex entries and picking one fires onScopeChange('codex', id)", () => {
    const onScopeChange = vi.fn();
    render(
      <ChatPanelHeader {...baseProps({ chatScope: "scene", onScopeChange })} />,
    );
    openDropdown();

    fireEvent.click(screen.getByRole("tab", { name: "chat.scope.tabCodex" }));
    fireEvent.click(screen.getByText("Alice"));

    expect(onScopeChange).toHaveBeenCalledWith("codex", "c1");
  });

  it("Snippet tab lists snippets and picking one fires onScopeChange('snippet', id)", () => {
    const onScopeChange = vi.fn();
    render(
      <ChatPanelHeader {...baseProps({ chatScope: "scene", onScopeChange })} />,
    );
    openDropdown();

    fireEvent.click(screen.getByRole("tab", { name: "chat.scope.tabSnippet" }));
    fireEvent.click(screen.getByText("Snip A"));

    expect(onScopeChange).toHaveBeenCalledWith("snippet", "s1");
  });

  it("opens on the Snippet tab when scope is already snippet", () => {
    render(
      <ChatPanelHeader
        {...baseProps({ chatScope: "snippet", scopeAnchorId: "s1" })}
      />,
    );
    openDropdown();

    const snippetTab = screen.getByRole("tab", {
      name: "chat.scope.tabSnippet",
    });
    expect(snippetTab.getAttribute("aria-selected")).toBe("true");
  });

  it("opens on the Codex tab when scope is already codex", () => {
    render(
      <ChatPanelHeader
        {...baseProps({ chatScope: "codex", scopeAnchorId: "c1" })}
      />,
    );
    openDropdown();

    const codexTab = screen.getByRole("tab", { name: "chat.scope.tabCodex" });
    expect(codexTab.getAttribute("aria-selected")).toBe("true");
  });

  it("shows the snippet title in the trigger label for snippet scope", () => {
    render(
      <ChatPanelHeader
        {...baseProps({ chatScope: "snippet", scopeAnchorId: "s1" })}
      />,
    );
    expect(screen.getByText("chat.scope.snippet: Snip A")).toBeInTheDocument();
  });

  it("disables the includeBodies toggle in snippet scope", () => {
    const onToggle = vi.fn();
    render(
      <ChatPanelHeader
        {...baseProps({
          chatScope: "snippet",
          scopeAnchorId: "s1",
          onToggleIncludeBodies: onToggle,
        })}
      />,
    );
    const toggle = screen.getByRole("button", {
      name: "chat.scope.bodiesUnavailableSnippet",
    });
    expect(toggle).toBeDisabled();
    fireEvent.click(toggle);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("portals the dropdown out of the component subtree (escapes .glass-chat)", () => {
    // 退行ガード: inline absolute に戻すと .glass-chat の backdrop-filter が作る
    // stacking context に閉じ込められ、他パネルに埋もれる。document.body へ
    // portal して祖先 stacking context を脱出していることを assert する。
    const { container } = render(
      <ChatPanelHeader {...baseProps({ chatScope: "scene" })} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "chat.scope.picker" }));
    const tablist = screen.getByRole("tablist");
    expect(container.contains(tablist)).toBe(false);
    expect(document.body.contains(tablist)).toBe(true);
  });

  it("keeps the portaled dropdown open on inner click, closes on outside mousedown", () => {
    // portal 後も dual-ref で外側クリック判定する退行ガード（ポータル内クリックで
    // 閉じない / 外側で閉じる）。
    render(<ChatPanelHeader {...baseProps({ chatScope: "scene" })} />);
    fireEvent.click(screen.getByRole("button", { name: "chat.scope.picker" }));
    expect(screen.getByRole("tablist")).toBeInTheDocument();
    fireEvent.mouseDown(
      screen.getByRole("tab", { name: "chat.scope.tabCodex" }),
    );
    expect(screen.queryByRole("tablist")).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("tablist")).toBeNull();
  });
});

describe("ChatPanelHeader — RAG egress disclosure (F-1)", () => {
  it("links the RAG toggle to an SR-readable egress + injection note via aria-describedby", () => {
    render(<ChatPanelHeader {...baseProps({ ragEnabled: true })} />);
    const toggle = screen.getByRole("button", { name: "chat.webSearch.on" });
    expect(toggle.getAttribute("aria-describedby")).toBe("rag-egress-note");

    // 第三者送信とプロンプトインジェクションの両方を開示する（F-1）。
    const note = document.getElementById("rag-egress-note");
    expect(note?.textContent).toContain("chat.webSearch.egressNote");
    expect(note?.textContent).toContain("chat.webSearch.injectionNote");
  });

  it("drops aria-describedby when the toggle is disabled", () => {
    render(
      <ChatPanelHeader
        {...baseProps({ ragDisabled: true, ragDisabledReason: "n/a" })}
      />,
    );
    const toggle = screen.getByRole("button", { name: "chat.webSearch.off" });
    expect(toggle.getAttribute("aria-describedby")).toBeNull();
  });
});

describe("ChatPanelHeader — Map overlay toggle gated on Map panel visibility", () => {
  it("disables the Map toggle when the Map panel is not shown", () => {
    const onToggle = vi.fn();
    render(
      <ChatPanelHeader
        {...baseProps({ mapDisabled: true, onToggleIncludeMapBoard: onToggle })}
      />,
    );
    const toggle = screen.getByRole("button", {
      name: "chat.mapOverlay.unavailable",
    });
    expect(toggle).toBeDisabled();
    fireEvent.click(toggle);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("enables the Map toggle when the Map panel is shown", () => {
    const onToggle = vi.fn();
    render(
      <ChatPanelHeader
        {...baseProps({
          mapDisabled: false,
          onToggleIncludeMapBoard: onToggle,
        })}
      />,
    );
    const toggle = screen.getByRole("button", { name: "chat.mapOverlay.off" });
    expect(toggle).not.toBeDisabled();
    fireEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
