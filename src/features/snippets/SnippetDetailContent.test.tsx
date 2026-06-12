// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { SnippetDetailContent } from "./SnippetDetailContent";
import type { Snippet } from "./api";
import {
  copyWithAttribution,
  handleCopyWithAttribution,
} from "@/lib/clipboardAttribution";

// ----- TipTap mocks -----
let editorHtml = "";
const setContentMock = vi.fn();
const onMock = vi.fn();
const offMock = vi.fn();
const destroyMock = vi.fn();

// useEditor must return a stable reference across renders, otherwise
// SnippetDetailContent's `editor`-dependent useEffect re-fires every render
// and resets the title state via setTitle(snippet.title).
const stableEditor = {
  getHTML: () => editorHtml,
  getJSON: () => ({}),
  getText: () => "",
  commands: { setContent: setContentMock },
  on: onMock,
  off: offMock,
  setEditable: vi.fn(),
  destroy: destroyMock,
};

vi.mock("@tiptap/react", () => ({
  useEditor: () => stableEditor,
  EditorContent: () => <div data-testid="tiptap-editor" />,
}));

vi.mock("@tiptap/starter-kit", () => ({
  default: { configure: () => ({}) },
}));

vi.mock("@/features/attribution/AuthorshipMark", () => ({
  AuthorshipMark: {},
}));

vi.mock("@/features/attribution/useAttribution", () => ({
  useAttribution: vi.fn(),
}));

vi.mock("@/features/editor/useCodexHighlight", () => ({
  useCodexHighlight: vi.fn(),
}));

vi.mock("@/features/editor/useTrashBinCapture", () => ({
  useTrashBinCapture: vi.fn(),
}));

vi.mock("@/features/editor/CodexPopover", () => ({
  CodexPopover: () => null,
}));

vi.mock("@/features/editor/sceneContentStore", () => ({
  useSceneContentStore: {
    getState: () => ({
      subscribe: vi.fn(() => () => {}),
      setLiveContent: vi.fn(),
    }),
  },
  subscribeLiveContentRafCoalesced: vi.fn(() => () => {}),
}));

vi.mock("@/features/editor/editorStore", () => ({
  useEditorStore: (
    selector: (s: { insertFromSnippet: () => boolean }) => unknown,
  ) => selector({ insertFromSnippet: vi.fn(() => true) }),
}));

vi.mock("@/features/editor/tabStore", () => ({
  useTabStore: { getState: () => ({ openSnippetTab: vi.fn() }) },
}));

vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: (selector: (s: { setActiveScene: () => void }) => unknown) =>
    selector({ setActiveScene: vi.fn() }),
}));

vi.mock("./snippetStore", () => ({
  useSnippetStore: (
    selector: (s: { incrementUsageCount: () => void }) => unknown,
  ) => selector({ incrementUsageCount: vi.fn() }),
}));

vi.mock("@/features/revision/revisionStore", () => ({
  useRevisionStore: Object.assign(
    () => ({
      shouldAutoRevision: () => false,
      recordAutoRevision: vi.fn(),
    }),
    {
      getState: () => ({ openHistory: vi.fn() }),
    },
  ),
}));

vi.mock("@/features/revision/api", () => ({
  createRevision: vi.fn(),
  pruneRevisions: vi.fn(),
}));

vi.mock("@/features/settings/settingsStore", () => {
  // zustand 形: hook として呼べて getState も持つ（spellCheck は hook 経由、
  // revision 設定は getState 経由で読まれる）
  const state = { getNumber: () => 5, getBoolean: () => false };
  const useSettingsStore = (selector: (s: typeof state) => unknown) =>
    selector(state);
  useSettingsStore.getState = () => state;
  return { useSettingsStore };
});

vi.mock("@/features/codex/tagApi", () => ({
  listSnippetEntryTags: vi.fn(() => Promise.resolve([])),
  setSnippetEntryTags: vi.fn(),
}));

vi.mock("@/features/codex/components/TagSelector", () => ({
  TagSelector: () => null,
}));

vi.mock("@/features/codex/components/TagsChip", () => ({
  TagsChip: () => null,
}));

vi.mock("@/lib/clipboardAttribution", () => ({
  copyWithAttribution: vi.fn(),
  handleCopyWithAttribution: vi.fn(),
}));

vi.mock("@/hooks/useFitsInline", () => ({
  useFitsInline: () => ({
    containerRef: { current: null },
    measureRef: { current: null },
    fits: true,
  }),
}));

const fakeSnippet = (overrides: Partial<Snippet> = {}): Snippet => ({
  id: "snippet-1",
  projectId: "default-project",
  title: "元のタイトル",
  content: "<p>元の内容</p>",
  tagsCache: null,
  contentSource: null,
  sceneId: null,
  sourceChatMessageId: null,
  usageCount: 0,
  createdAt: "2025-01-01T00:00:00Z",
  updatedAt: "2025-01-01T00:00:00Z",
  ...overrides,
});

describe("SnippetDetailContent — autosave flush on unmount", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    editorHtml = "";
  });

  it("flushes pending edits to onSave when unmounted before debounce fires", () => {
    // Regression guard for commit 9cf2644: SnippetPanel keys
    // SnippetDetailContent by snippet.id, so switching to another entry
    // unmounts the component. The previous (debounced) save would be lost
    // unless useAutoSave's unmount-cleanup flushes it.
    const onSave = vi.fn();
    editorHtml = "<p>編集中の本文</p>";

    const { unmount, getByTestId } = render(
      <SnippetDetailContent
        snippet={fakeSnippet()}
        onSave={onSave}
        onDelete={vi.fn()}
      />,
    );

    // Trigger schedule (sets useAutoSave's `pending` flag) by editing title.
    const titleInput = getByTestId("snippet-detail-title") as HTMLInputElement;
    fireEvent.change(titleInput, { target: { value: "編集後のタイトル" } });

    // Sanity: 2-second debounce hasn't fired yet — no save yet.
    expect(onSave).not.toHaveBeenCalled();

    // Simulate SnippetPanel switching to another entry → key change → unmount.
    unmount();

    // useAutoSave's unmount cleanup must flush pending edits with the
    // latest title (from titleRef) and the latest editor.getHTML().
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith("snippet-1", {
      title: "編集後のタイトル",
      content: "<p>編集中の本文</p>",
    });
  });

  it("does not call onSave if no edits were scheduled before unmount", () => {
    const onSave = vi.fn();
    const { unmount } = render(
      <SnippetDetailContent
        snippet={fakeSnippet()}
        onSave={onSave}
        onDelete={vi.fn()}
      />,
    );

    // No edits made → autosave was never scheduled → flush is a no-op.
    unmount();
    expect(onSave).not.toHaveBeenCalled();
  });
});

describe("SnippetDetailContent — コピー時の source 伝搬", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    editorHtml = "";
  });

  const renderDetail = (overrides: Partial<Snippet>) =>
    render(
      <SnippetDetailContent
        snippet={fakeSnippet(overrides)}
        onSave={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

  it("editor.spellCheck 設定 (default false) が本文ラッパーの spellcheck 属性に届く", () => {
    // 設定UIのみ存在し contenteditable に届かなかった配線漏れの regression
    // gate。属性が無いとブラウザ既定 (=有効) にフォールバックする。
    const { container } = renderDetail({});
    const el = container.querySelector("div[spellcheck]");
    expect(el).not.toBeNull();
    expect(el!.getAttribute("spellcheck")).toBe("false");
  });

  it("AI snippet のコピーボタンは source='ai' で copyWithAttribution を呼ぶ", () => {
    const { getByTestId } = renderDetail({ contentSource: "ai" });
    fireEvent.click(getByTestId("snippet-copy-button"));
    expect(copyWithAttribution).toHaveBeenCalledWith(expect.anything(), "ai");
  });

  it("AI snippet 本文の onCopy は source='ai' を注入する", () => {
    const { getByTestId } = renderDetail({ contentSource: "ai" });
    // tiptap-editor は本文 div の子。copy は bubble して本文 div の onCopy へ。
    fireEvent.copy(getByTestId("tiptap-editor"));
    expect(handleCopyWithAttribution).toHaveBeenCalledWith(
      expect.anything(),
      "ai",
    );
  });

  it("contentSource=null の snippet は 'human' にフォールバックする", () => {
    const { getByTestId } = renderDetail({ contentSource: null });
    fireEvent.click(getByTestId("snippet-copy-button"));
    expect(copyWithAttribution).toHaveBeenCalledWith(
      expect.anything(),
      "human",
    );
  });
});
