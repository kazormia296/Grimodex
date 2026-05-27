// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useRef } from "react";
import type { Editor } from "@tiptap/react";
import { useCursorSettingsStore } from "@/features/editor/cursorSettingsStore";

const { mockCodexCreate, mockRequestSelectEntry, mockShowPanel } = vi.hoisted(
  () => ({
    mockCodexCreate: vi.fn(),
    mockRequestSelectEntry: vi.fn(),
    mockShowPanel: vi.fn(),
  }),
);

const { mockUseCodexStore } = vi.hoisted(() => {
  const codexState = {
    get create() {
      return mockCodexCreate;
    },
    get requestSelectEntry() {
      return mockRequestSelectEntry;
    },
    entries: [] as Array<Record<string, unknown>>,
  };
  const store = Object.assign(
    (sel: (s: typeof codexState) => unknown) => sel(codexState),
    { getState: () => codexState },
  );
  return { mockUseCodexStore: store };
});

const { mockSnippetCreate } = vi.hoisted(() => ({
  mockSnippetCreate: vi.fn(),
}));

vi.mock("@/features/codex/codexStore", () => ({
  useCodexStore: mockUseCodexStore,
}));
vi.mock("@/features/layout/layoutStore", () => ({
  useLayoutStore: { getState: () => ({ showPanel: mockShowPanel }) },
}));
vi.mock("@/features/snippets/snippetStore", () => ({
  useSnippetStore: (
    sel: (s: {
      create: typeof mockSnippetCreate;
      entries: never[];
      loadEntries: () => Promise<void>;
      incrementUsageCount: () => Promise<void>;
    }) => unknown,
  ) =>
    sel({
      create: mockSnippetCreate,
      entries: [],
      loadEntries: async () => {},
      incrementUsageCount: async () => {},
    }),
}));
vi.mock("@/features/tree/store", () => ({
  useSceneStore: (sel: (s: { activeSceneId: string }) => unknown) =>
    sel({ activeSceneId: "scene-1" }),
}));
vi.mock("@/features/codex/api", () => ({
  BUILTIN_CODEX_TYPES: ["character"],
}));

import { EditorContextMenu } from "./EditorContextMenu";

function makeEditor(text: string): Editor {
  return {
    state: {
      selection: { empty: false, from: 0, to: text.length },
      doc: {
        textBetween: () => text,
        nodesBetween: () => undefined,
        resolve: () => ({ marks: () => [] }),
        content: { size: text.length },
      },
    },
    isActive: () => false,
  } as unknown as Editor;
}

function Wrapper({ editor }: { editor: Editor | null }) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div ref={ref} data-testid="container">
      <EditorContextMenu editor={editor} containerRef={ref} />
    </div>
  );
}

describe("EditorContextMenu - 伏線を要請", () => {
  afterEach(() => {
    useCursorSettingsStore.setState({
      foreshadowPickerOpen: false,
      foreshadowPickerInitialMode: null,
    });
  });

  it("選択がある場合に「伏線を要請」が表示される", async () => {
    const editor = makeEditor("サンプルテキスト");
    const { getByTestId } = render(<Wrapper editor={editor} />);
    fireEvent.contextMenu(getByTestId("container"), {
      clientX: 100,
      clientY: 100,
    });
    expect(await screen.findByText("伏線を要請")).toBeInTheDocument();
  });

  it("「伏線を要請」クリックで foreshadowPickerOpen=true かつ initialMode='payoff' になる", async () => {
    const editor = makeEditor("サンプルテキスト");
    const { getByTestId } = render(<Wrapper editor={editor} />);
    fireEvent.contextMenu(getByTestId("container"), {
      clientX: 100,
      clientY: 100,
    });
    const btn = await screen.findByText("伏線を要請");
    fireEvent.click(btn);
    const state = useCursorSettingsStore.getState();
    expect(state.foreshadowPickerOpen).toBe(true);
    expect(state.foreshadowPickerInitialMode).toBe("payoff");
  });
});

describe("EditorContextMenu - 伏線として登録", () => {
  afterEach(() => {
    useCursorSettingsStore.setState({
      foreshadowPickerOpen: false,
      foreshadowPickerInitialMode: null,
    });
  });

  it("選択がある場合に「伏線として登録」が表示される", async () => {
    const editor = makeEditor("サンプルテキスト");
    const { getByTestId } = render(<Wrapper editor={editor} />);
    fireEvent.contextMenu(getByTestId("container"), {
      clientX: 100,
      clientY: 100,
    });
    expect(await screen.findByText("伏線として登録")).toBeInTheDocument();
  });

  it("「伏線として登録」クリックで initialMode='setup' になる", async () => {
    const editor = makeEditor("サンプルテキスト");
    const { getByTestId } = render(<Wrapper editor={editor} />);
    fireEvent.contextMenu(getByTestId("container"), {
      clientX: 100,
      clientY: 100,
    });
    fireEvent.click(await screen.findByText("伏線として登録"));
    const state = useCursorSettingsStore.getState();
    expect(state.foreshadowPickerOpen).toBe(true);
    expect(state.foreshadowPickerInitialMode).toBe("setup");
  });
});

describe("EditorContextMenu - 回収先として指名", () => {
  afterEach(() => {
    useCursorSettingsStore.setState({
      foreshadowPickerOpen: false,
      foreshadowPickerInitialMode: null,
    });
  });

  it("選択がある場合に「回収先として指名」が表示される", async () => {
    const editor = makeEditor("サンプルテキスト");
    const { getByTestId } = render(<Wrapper editor={editor} />);
    fireEvent.contextMenu(getByTestId("container"), {
      clientX: 100,
      clientY: 100,
    });
    expect(await screen.findByText("回収先として指名")).toBeInTheDocument();
  });

  it("「回収先として指名」クリックで initialMode='payoff-unanchored' になる", async () => {
    const editor = makeEditor("サンプルテキスト");
    const { getByTestId } = render(<Wrapper editor={editor} />);
    fireEvent.contextMenu(getByTestId("container"), {
      clientX: 100,
      clientY: 100,
    });
    fireEvent.click(await screen.findByText("回収先として指名"));
    const state = useCursorSettingsStore.getState();
    expect(state.foreshadowPickerOpen).toBe(true);
    expect(state.foreshadowPickerInitialMode).toBe("payoff-unanchored");
  });
});
