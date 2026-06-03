// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ChatPanelHeader } from "./ChatPanelHeader";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));
// セレクタ式の Zustand フックを最小スタブ化（本テストは RAG トグルの
// アクセシビリティ開示だけを検証する）。
vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: (sel: (s: { nodes: unknown[] }) => unknown) =>
    sel({ nodes: [] }),
}));
vi.mock("@/features/layout/layoutStore", () => ({
  useLayoutStore: (sel: (s: { activePresetId: string | null }) => unknown) =>
    sel({ activePresetId: null }),
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
    onToggleIncludeMapBoard: vi.fn(),
    ragEnabled: false,
    ragDisabled: false,
    onToggleRag: vi.fn(),
    ...over,
  };
}

describe("ChatPanelHeader — RAG egress disclosure (F-1)", () => {
  it("links the RAG toggle to an SR-readable egress note via aria-describedby", () => {
    render(<ChatPanelHeader {...baseProps({ ragEnabled: true })} />);
    const toggle = screen.getByRole("button", { name: "chat.webSearch.on" });
    expect(toggle.getAttribute("aria-describedby")).toBe("rag-egress-note");

    const note = document.getElementById("rag-egress-note");
    expect(note?.textContent).toBe("chat.webSearch.egressNote");
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
