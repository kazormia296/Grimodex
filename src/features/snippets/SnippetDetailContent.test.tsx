// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, act, waitFor } from "@testing-library/react";
import { SnippetDetailContent } from "./SnippetDetailContent";
import type { Snippet } from "./api";
import { flushAllAutoSaves } from "@/hooks/useAutoSave";
import {
  copyWithAttribution,
  handleCopyWithAttribution,
} from "@/lib/clipboardAttribution";
import { announcePersistedBinding } from "@/features/editor/editorSaveRegistry";
import { createEditorInstanceId } from "@/features/editor/document/documentKey";
import { toast } from "sonner";

// ----- TipTap mocks -----
let editorHtml = "";
const setContentMock = vi.fn();
const onMock = vi.fn();
const offMock = vi.fn();
const destroyMock = vi.fn();
const snippetStoreStateMock = vi.hoisted(() => ({
  entries: [] as Snippet[],
  incrementUsageCount: vi.fn(),
}));

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
  useSnippetStore: Object.assign(
    (selector: (s: typeof snippetStoreStateMock) => unknown) =>
      selector(snippetStoreStateMock),
    { getState: () => snippetStoreStateMock },
  ),
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
  copyWithAttribution: vi.fn(() => Promise.resolve()),
  handleCopyWithAttribution: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
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
  version: 0,
  createdAt: "2025-01-01T00:00:00Z",
  updatedAt: "2025-01-01T00:00:00Z",
  ...overrides,
});

describe("SnippetDetailContent — autosave flush on unmount", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    editorHtml = "";
  });

  it("flushes pending edits to onSave when unmounted before debounce fires", async () => {
    // Regression guard for commit 9cf2644: SnippetPanel keys
    // SnippetDetailContent by snippet.id, so switching to another entry
    // unmounts the component. The previous (debounced) save would be lost
    // unless useAutoSave's unmount-cleanup flushes it.
    const onSave = vi.fn().mockResolvedValue({ persisted: true, version: 1 });
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

    // useAutoSave's unmount cleanup must flush the dirty title lane. Content
    // is intentionally omitted so a stale mini-editor body cannot roll back a
    // peer body save.
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith(
      "snippet-1",
      {
        title: "編集後のタイトル",
      },
      {
        baseVersion: 0,
      },
    );
  });

  it("does not call onSave if no edits were scheduled before unmount", () => {
    const onSave = vi.fn().mockResolvedValue({ persisted: true, version: 1 });
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

  it("uses the loaded version and advances it only after each successful save", async () => {
    const onSave = vi
      .fn()
      .mockResolvedValueOnce({ persisted: true, version: 4 })
      .mockResolvedValueOnce({ persisted: true, version: 5 });
    const { getByTestId } = render(
      <SnippetDetailContent
        snippet={fakeSnippet({ version: 3 })}
        onSave={onSave}
        onDelete={vi.fn()}
      />,
    );
    const titleInput = getByTestId("snippet-detail-title") as HTMLInputElement;

    fireEvent.change(titleInput, { target: { value: "first" } });
    await act(async () => {
      await flushAllAutoSaves();
    });
    fireEvent.change(titleInput, { target: { value: "second" } });
    await act(async () => {
      await flushAllAutoSaves();
    });

    expect(onSave.mock.calls[0]?.[2]).toEqual({ baseVersion: 3 });
    expect(onSave.mock.calls[1]?.[2]).toEqual({ baseVersion: 4 });
  });

  it("propagates a non-persisted save through explicit quiesce", async () => {
    const onSave = vi.fn().mockResolvedValue({
      persisted: false,
      version: null,
    });
    const { getByTestId } = render(
      <SnippetDetailContent
        snippet={fakeSnippet({ version: 6 })}
        onSave={onSave}
        onDelete={vi.fn()}
      />,
    );

    fireEvent.change(getByTestId("snippet-detail-title"), {
      target: { value: "unsaved" },
    });

    await expect(flushAllAutoSaves()).rejects.toThrow(
      "snippet detail save not persisted",
    );
    expect(onSave.mock.calls[0]?.[2]).toEqual({ baseVersion: 6 });
    onSave.mockResolvedValue({ persisted: true, version: 7 });
    await flushAllAutoSaves();
  });

  it("adopts a peer title save and never writes the stale title with a later body save", async () => {
    const onSave = vi.fn().mockResolvedValue({ persisted: true, version: 5 });
    snippetStoreStateMock.entries = [
      fakeSnippet({ title: "peer title", version: 4 }),
    ];
    const { getByTestId, unmount } = render(
      <SnippetDetailContent
        snippet={fakeSnippet({ title: "old title", version: 3 })}
        onSave={onSave}
        onDelete={vi.fn()}
      />,
    );

    act(() => {
      announcePersistedBinding(
        { kind: "snippet", id: "snippet-1" },
        createEditorInstanceId("peer"),
        { kind: "snippet", id: "snippet-1", loadedVersion: 4 },
      );
    });
    expect(getByTestId("snippet-detail-title")).toHaveValue("peer title");

    editorHtml = "<p>edited body</p>";
    const updateHandler = onMock.mock.calls.find(
      ([eventName]) => eventName === "update",
    )?.[1] as (() => void) | undefined;
    act(() => updateHandler?.());
    unmount();
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());

    expect(onSave).toHaveBeenCalledWith(
      "snippet-1",
      { content: "<p>edited body</p>" },
      { baseVersion: 4 },
    );
  });
});

describe("SnippetDetailContent — コピー時の source 伝搬", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(copyWithAttribution).mockResolvedValue(undefined);
    editorHtml = "";
  });

  const renderDetail = (overrides: Partial<Snippet>) =>
    render(
      <SnippetDetailContent
        snippet={fakeSnippet(overrides)}
        onSave={vi.fn().mockResolvedValue({ persisted: true, version: 1 })}
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

  it("コピー拒否時は失敗 toast を出し、成功表示を出さない", async () => {
    vi.mocked(copyWithAttribution).mockRejectedValueOnce(new Error("denied"));
    const { getByTestId } = renderDetail({});

    fireEvent.click(getByTestId("snippet-copy-button"));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("コピーに失敗しました"),
    );
    expect(toast.success).not.toHaveBeenCalled();
  });
});
