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
