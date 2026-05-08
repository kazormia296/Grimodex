// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { SnippetDetailContent } from "./SnippetDetailContent";
import type { Snippet } from "./api";

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

vi.mock("@/features/settings/settingsStore", () => ({
  useSettingsStore: {
    getState: () => ({ getNumber: () => 5 }),
  },
}));

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
