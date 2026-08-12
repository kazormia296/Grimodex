// @vitest-environment happy-dom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { Editor as TiptapEditor } from "@tiptap/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SCENE_ID = "scene-parity";
const DOCUMENT_KEY = {
  kind: "tree" as const,
  id: SCENE_ID,
  storage: "database" as const,
};

type Surface = "tab" | "linear";

interface AutoSaveController {
  scheduleCalls: number;
  schedule: () => void;
  cancel: () => void;
  pause: () => void;
  resume: () => void;
  flush: () => Promise<void>;
}

const harness = vi.hoisted(() => ({
  sceneId: "scene-parity",
  sceneContent: {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: "alpha" }],
      },
      {
        type: "sceneBeat",
        attrs: {
          id: "beat-1",
          collapsed: false,
          beatType: "free",
          pov: null,
        },
        content: [{ type: "text", text: "first beat" }],
      },
    ],
  } as Record<string, unknown>,
  storage: "database" as "database" | "file",
  activeSurface: "tab" as Surface,
  editors: {
    tab: [] as TiptapEditor[],
    linear: [] as TiptapEditor[],
  },
  autoSave: {
    tab: [] as AutoSaveController[],
    linear: [] as AutoSaveController[],
  },
  timelapse: {
    tab: [] as unknown[],
    linear: [] as unknown[],
  },
  persisted: {
    tab: [] as unknown[],
    linear: [] as unknown[],
  },
}));

function makeSceneContent(text: string): Record<string, unknown> {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text }],
      },
      {
        type: "sceneBeat",
        attrs: {
          id: "beat-1",
          collapsed: false,
          beatType: "free",
          pov: null,
        },
        content: [{ type: "text", text: "first beat" }],
      },
    ],
  };
}

vi.mock("@tiptap/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tiptap/react")>();
  const { Editor } = await import("@tiptap/core");
  const { useEffect, useState } = await import("react");
  return {
    ...actual,
    useEditor: (config: Record<string, unknown>) => {
      const surface = harness.activeSurface;
      const [editor] = useState(() => {
        const instance = new Editor(config as never);
        harness.editors[surface].push(instance);
        return instance;
      });
      useEffect(
        () => () => {
          editor.destroy();
        },
        [editor],
      );
      return editor;
    },
    EditorContent: () => <div data-testid="linear-editor-content" />,
  };
});

vi.mock("@/features/editor/extensions", async () => {
  const [{ default: StarterKit }, { SceneBeatNode }] = await Promise.all([
    import("@tiptap/starter-kit"),
    import("@/features/editor/SceneBeatNode"),
  ]);
  return {
    getEditorExtensions: () => [StarterKit, SceneBeatNode],
  };
});

vi.mock("@/features/external-mount/fileBackedEditorExtensions", async () => {
  const [{ default: StarterKit }, { SceneBeatNode }] = await Promise.all([
    import("@tiptap/starter-kit"),
    import("@/features/editor/SceneBeatNode"),
  ]);
  return {
    getFileBackedEditorExtensions: () => [StarterKit, SceneBeatNode],
    sanitizePastedMarkdown: (value: string) => value,
  };
});

vi.mock("@/hooks/useAutoSave", async () => {
  const { useRef } = await import("react");
  return {
    useAutoSave: (saveFn: () => Promise<void>) => {
      const saveRef = useRef(saveFn);
      saveRef.current = saveFn;
      const controllerRef = useRef<AutoSaveController | null>(null);
      const pendingRef = useRef(false);
      if (controllerRef.current === null) {
        const surface = harness.activeSurface;
        const controller: AutoSaveController = {
          scheduleCalls: 0,
          schedule() {
            controller.scheduleCalls += 1;
            pendingRef.current = true;
          },
          cancel() {
            pendingRef.current = false;
          },
          pause() {},
          resume() {},
          async flush() {
            if (!pendingRef.current) return;
            pendingRef.current = false;
            await saveRef.current();
          },
        };
        controllerRef.current = controller;
        harness.autoSave[surface].push(controller);
      }
      return controllerRef.current;
    },
  };
});

vi.mock("@/features/timelapse/recorder", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/timelapse/recorder")>();
  return {
    ...actual,
    recordChangeEvent: (input: unknown) => {
      harness.timelapse[harness.activeSurface].push(input);
    },
  };
});

vi.mock("@/features/editor/document/loadEditorDocument", () => ({
  targetFromTab: (
    _contentType: string,
    id: string,
    options?: {
      tree?: { nodeType?: "scene" | "note"; storage?: "database" | "file" };
    },
  ) => ({
    kind: "tree",
    id,
    nodeType: options?.tree?.nodeType ?? "scene",
    storage: options?.tree?.storage ?? "database",
  }),
  loadEditorDocument: vi.fn(async () => ({
    binding: {
      kind: "tree",
      id: harness.sceneId,
      nodeType: "scene",
      storage: harness.storage,
      loadedVersion: 0,
    },
    content: harness.sceneContent,
    unplacedBeatsDoc: "[]",
    projectId: "project-1",
  })),
}));

vi.mock("@/features/editor/document/sceneSidecars", () => ({
  loadSceneSidecars: vi.fn(async () => ({
    authorshipSpans: [],
    foreshadowAnchors: [],
  })),
  applySceneSidecars: vi.fn(),
}));

vi.mock("@/features/editor/document/saveEditorDocument", () => ({
  defaultEditorDocumentServices: {},
  saveEditorDocument: vi.fn(
    async (binding: unknown, doc: TiptapEditor["state"]["doc"]) => {
      harness.persisted.tab.push(doc.toJSON());
      return { binding };
    },
  ),
}));

vi.mock("@/features/editor/persistSceneBody", () => ({
  persistSceneBody: vi.fn(
    async (_sceneId: string, doc: TiptapEditor["state"]["doc"]) => {
      harness.persisted.linear.push(doc.toJSON());
      return {
        placedBeatPreview: null,
        unplacedBeatPreview: null,
        contentVersion: 1,
        contentUpdatedAt: "2100-01-01T00:00:00.000Z",
        dbTransactionCount: 1,
        foreshadowRows: [],
      };
    },
  ),
}));

vi.mock("@/features/tree/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/tree/api")>();
  return {
    ...actual,
    loadSceneFull: vi.fn(async () => ({
      content: JSON.stringify(harness.sceneContent),
      unplacedBeatsDoc: "[]",
      projectId: "project-1",
      version: 0,
    })),
    savePlacedBeatPreviewOnly: vi.fn(async () => ({
      contentVersion: 1,
      contentUpdatedAt: "2100-01-01T00:00:00.000Z",
    })),
  };
});

vi.mock("@/features/attribution/api", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/attribution/api")>();
  return {
    ...actual,
    loadAuthorshipSpans: vi.fn(async () => []),
    spansToMarkData: vi.fn(() => []),
  };
});

vi.mock("@/features/license/useLicenseEditableSync", () => ({
  useLicenseEditableSync: (
    editor: TiptapEditor | null,
    forceReadOnly = false,
  ) => {
    editor?.setEditable(!forceReadOnly, false);
  },
}));

vi.mock("@/features/settings/hooks/useEditorSettings", () => ({
  useEditorSettings: () => ({
    autoSaveDelay: 600_000,
    showLineNumbers: false,
    linearBeatDisplay: "full",
    fontFamily: "serif",
    fontSize: 16,
    lineHeight: 1.8,
    maxContentWidth: 800,
    wordBreak: "normal",
    lineBreak: "auto",
    paragraphIndent: 0,
    paragraphSpacing: 8,
    spellCheck: false,
    focusModeHideBeats: false,
    sceneMetaPanelOpen: false,
    sceneMetaPanelWidth: 30,
    verticalMode: false,
  }),
}));

vi.mock("@/runtime/workspaceViewportContext", () => ({
  useWorkspaceViewportProfile: () => "wide",
}));

vi.mock("@/features/editor/useEditorViewReady", () => ({
  useEditorViewReady: (editor: TiptapEditor | null) => Boolean(editor),
}));

vi.mock("@/features/editor/isEditorViewReady", () => ({
  isEditorViewReady: (editor: TiptapEditor | null) =>
    Boolean(editor && !editor.isDestroyed),
}));

vi.mock("@/features/editor/useBeatDragDrop", () => ({
  useBeatDragDrop: () => ({
    sensors: [],
    collisionDetection: vi.fn(),
    draggingBeat: null,
    onDragStart: vi.fn(),
    onDragEnd: vi.fn(),
  }),
}));

vi.mock("@/features/editor/reorder/useParagraphReorderOverlay", () => ({
  useParagraphReorderOverlay: () => ({
    open: false,
    closeOverlay: vi.fn(),
    toggleOverlay: vi.fn(),
    units: [],
    order: [],
    setOrder: vi.fn(),
    granularity: "paragraph",
    setGranularity: vi.fn(),
    loading: false,
    errorMessage: null,
    canConfirm: false,
    confirm: vi.fn(),
  }),
}));

vi.mock("@/features/trash-bin/useDropTarget", async () => {
  const { createRef } = await import("react");
  return {
    useDropTarget: () => createRef<HTMLDivElement>(),
  };
});

vi.mock("@/features/editor/useRequestedEditorFocus", () => ({
  useRequestedEditorFocus: vi.fn(),
}));
vi.mock("@/features/editor/useInsertHighlight", () => ({
  useInsertHighlight: vi.fn(),
}));
vi.mock("@/features/editor/useGhostPreview", () => ({
  useGhostPreview: vi.fn(),
}));
vi.mock("@/features/editor/useCodexHighlight", () => ({
  useCodexHighlight: vi.fn(),
}));
vi.mock("@/features/attribution/useAttribution", () => ({
  useAttribution: vi.fn(),
}));
vi.mock("@/features/editor/useCursorOverlay", () => ({
  useCursorOverlay: vi.fn(),
}));
vi.mock("@/features/editor/useImeDiagnostics", () => ({
  useImeDiagnostics: vi.fn(),
}));
vi.mock("@/features/editor/useCharacterFade", () => ({
  useCharacterFade: vi.fn(),
}));
vi.mock("@/features/editor/useTateChuYoko", () => ({
  useTateChuYoko: vi.fn(),
}));
vi.mock("@/features/editor/useShowInvisibles", () => ({
  useShowInvisibles: vi.fn(),
}));
vi.mock("@/features/editor/codexCompletion/useCodexCompletion", () => ({
  useCodexCompletion: vi.fn(),
}));
vi.mock("@/features/editor/useFocusMode", () => ({
  useFocusMode: vi.fn(),
}));
vi.mock("@/features/editor/useTypewriterScroll", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/features/editor/useTypewriterScroll")
    >();
  return {
    ...actual,
    useTypewriterScroll: vi.fn(),
  };
});
vi.mock("@/features/lint/useLinter", () => ({
  useLinter: vi.fn(),
}));
vi.mock("@/features/editor/useTrashBinCapture", () => ({
  useTrashBinCapture: vi.fn(),
}));
vi.mock("@/features/editor/useEditorKeyboard", () => ({
  useEditorKeyboard: vi.fn(),
}));

vi.mock("@/features/editor/inlineAi/useInlineAiDiff", () => ({
  useInlineAiDiff: () => ({
    generate: vi.fn(),
    retry: vi.fn(),
    showProvidedText: vi.fn(),
    accept: vi.fn(),
    reject: vi.fn(),
    rejectOrAbort: vi.fn(),
  }),
}));

vi.mock("@/features/editor/inlineAi/useAgentProseStaging", () => ({
  useAgentProseStaging: () => ({
    acceptWithStaging: vi.fn(),
    rejectWithStaging: vi.fn(),
  }),
}));

vi.mock("@/features/editor/useLinearInlineAi", () => ({
  useLinearInlineAi: () => ({
    generate: vi.fn(),
    accept: vi.fn(),
    rejectOrAbort: vi.fn(),
    retry: vi.fn(),
    paletteOpen: false,
    palettePreselect: null,
    closePalette: vi.fn(),
    submitPalette: vi.fn(),
    toolbarVisible: false,
  }),
}));

vi.mock("@/features/editor/Toolbar", () => ({
  Toolbar: () => null,
}));
vi.mock("@/features/editor/EditorPaneRibbon", () => ({
  EditorPaneRibbon: () => null,
}));
vi.mock("@/features/editor/EditorPaneViewport", () => ({
  EditorPaneViewport: () => <div data-testid="tab-editor-viewport" />,
}));
vi.mock("@/features/editor/EditorPaneStatusBar", () => ({
  EditorPaneStatusBar: () => null,
}));
vi.mock("@/features/editor/EditorPaneOverlays", () => ({
  EditorPaneOverlays: () => null,
}));
vi.mock("@/features/editor/PhoneSceneMetaSheet", () => ({
  PhoneSceneMetaSheet: () => null,
}));
vi.mock("@/features/editor/SceneMetaPanel", () => ({
  SceneMetaPanel: () => null,
}));
vi.mock("@/features/editor/ExternalEditConflictBanner", () => ({
  ExternalEditConflictBanner: () => null,
}));
vi.mock("@/features/editor/EditorContentSkeleton", () => ({
  EditorContentSkeleton: () => null,
}));
vi.mock("@/features/editor/inlineAi/InlineAIToolbar", () => ({
  InlineAIToolbar: () => null,
}));
vi.mock("@/features/editor/inlineAi/InlineAIPalette", () => ({
  InlineAIPalette: () => null,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", StubResizeObserver);

import { EditorPane } from "./EditorPane";
import { LinearSceneBlock } from "./LinearSceneBlock";
import { useUnplacedBeatsStore } from "./beat/unplacedBeatsStore";
import { loadEditorDocument } from "./document/loadEditorDocument";
import { useEditorSessionStore } from "./editorSessionStore";
import { useInlineAiStore } from "./inlineAi/inlineAiStore";
import { useExternalWriteStore } from "../concurrency/externalWriteStore";
import { useTreeStore, type TreeNodeData } from "../tree/treeStore";

const SCENE: TreeNodeData = {
  id: SCENE_ID,
  projectId: "project-1",
  parentId: null,
  nodeType: "scene",
  title: "Parity Scene",
  synopsis: null,
  intent: null,
  sortOrder: "a0",
  status: "draft",
  storyTimeOrder: null,
  storyTimeLabel: null,
  povCharacterId: null,
  locationId: null,
  charCount: 0,
  sourceUri: null,
  sourceMtime: null,
  archivedAt: null,
  createdAt: "2026-07-28T00:00:00.000Z",
  updatedAt: "2026-07-28T00:00:00.000Z",
};

interface SurfaceObservation {
  dirtyBeforeSave: boolean;
  dirtyAfterSave: boolean;
  saveWasScheduled: boolean;
  persistedDocument: unknown;
  timelapse: unknown[];
  unplacedBeats: unknown[];
  preview: unknown;
}

function latestEditor(surface: Surface): TiptapEditor {
  const editor = harness.editors[surface].at(-1);
  if (!editor) throw new Error(`No ${surface} editor was created`);
  return editor;
}

function latestAutoSave(surface: Surface): AutoSaveController {
  const controller = harness.autoSave[surface].at(-1);
  if (!controller) throw new Error(`No ${surface} autosave was created`);
  return controller;
}

function findBeat(editor: TiptapEditor): { pos: number; nodeSize: number } {
  let result: { pos: number; nodeSize: number } | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name !== "sceneBeat") return true;
    result = { pos, nodeSize: node.nodeSize };
    return false;
  });
  if (!result) throw new Error("Loaded editor is missing sceneBeat");
  return result;
}

async function observeSurface(surface: Surface): Promise<SurfaceObservation> {
  harness.activeSurface = surface;
  const view =
    surface === "tab"
      ? render(
          <EditorPane
            nodeId={SCENE_ID}
            contentType="scene"
            groupIndex={0}
            onFocus={() => {}}
          />,
        )
      : render(
          <LinearSceneBlock
            sceneId={SCENE_ID}
            scene={SCENE}
            isMounted
            isActive
            placeholderHeight={300}
            onHeightChange={() => {}}
            onFocus={() => {}}
          />,
        );

  await waitFor(() => {
    expect(findBeat(latestEditor(surface))).toBeDefined();
    expect(latestEditor(surface).isEditable).toBe(true);
  });

  harness.timelapse[surface].length = 0;
  harness.persisted[surface].length = 0;
  useUnplacedBeatsStore.getState().setBeats(SCENE_ID, [], "load");
  useTreeStore.setState({ nodePreviews: {} });
  const autoSave = latestAutoSave(surface);
  autoSave.scheduleCalls = 0;

  const editor = latestEditor(surface);
  const beat = findBeat(editor);
  act(() => {
    editor.view.dispatch(
      editor.state.tr.delete(beat.pos, beat.pos + beat.nodeSize),
    );
  });

  await waitFor(() => {
    expect(useEditorSessionStore.getState().isDocumentDirty(DOCUMENT_KEY)).toBe(
      true,
    );
    expect(useUnplacedBeatsStore.getState().getBeats(SCENE_ID)).toHaveLength(1);
  });

  const dirtyBeforeSave = useEditorSessionStore
    .getState()
    .isDocumentDirty(DOCUMENT_KEY);
  const saveWasScheduled = autoSave.scheduleCalls > 0;
  const timelapse = structuredClone(harness.timelapse[surface]);
  const unplacedBeats = structuredClone(
    useUnplacedBeatsStore.getState().getBeats(SCENE_ID),
  );
  const preview = structuredClone(
    useTreeStore.getState().nodePreviews[SCENE_ID] ?? null,
  );

  await act(async () => {
    await autoSave.flush();
  });
  await waitFor(() => {
    expect(useEditorSessionStore.getState().isDocumentDirty(DOCUMENT_KEY)).toBe(
      false,
    );
  });

  const observation = {
    dirtyBeforeSave,
    dirtyAfterSave: useEditorSessionStore
      .getState()
      .isDocumentDirty(DOCUMENT_KEY),
    saveWasScheduled,
    persistedDocument: structuredClone(harness.persisted[surface].at(-1)),
    timelapse,
    unplacedBeats,
    preview,
  };

  view.unmount();
  return observation;
}

beforeEach(() => {
  harness.activeSurface = "tab";
  harness.sceneContent = makeSceneContent("alpha");
  harness.storage = "database";
  for (const surface of ["tab", "linear"] as const) {
    harness.editors[surface].length = 0;
    harness.autoSave[surface].length = 0;
    harness.timelapse[surface].length = 0;
    harness.persisted[surface].length = 0;
  }
  useExternalWriteStore.getState().clear();
  useInlineAiStore.getState().reset();
  useEditorSessionStore.getState().resetForProject();
  useUnplacedBeatsStore.setState({ sceneBeats: {} });
  useTreeStore.setState({
    nodes: [SCENE],
    scenes: [SCENE],
    activeSceneId: SCENE_ID,
    projectId: "project-1",
    nodePreviews: {},
    charCounts: {},
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Editor scene surface parity", () => {
  it("observes identical dirty, save, Timelapse, Beat, and preview results from a real transaction", async () => {
    const tab = await observeSurface("tab");

    useEditorSessionStore.getState().resetForProject();
    useUnplacedBeatsStore.setState({ sceneBeats: {} });
    useTreeStore.setState({ nodePreviews: {} });

    const linear = await observeSurface("linear");

    expect(tab).toEqual(linear);
    expect(tab).toMatchObject({
      dirtyBeforeSave: true,
      dirtyAfterSave: false,
      saveWasScheduled: true,
      timelapse: [
        expect.objectContaining({
          domain: "editor",
          opType: "doc.step",
          sceneId: SCENE_ID,
        }),
      ],
      unplacedBeats: [
        expect.objectContaining({
          id: "beat-1",
          content: [{ type: "text", text: "first beat" }],
        }),
      ],
      preview: {
        placed: null,
        unplaced: JSON.stringify(["first beat"]),
      },
    });
  });

  it("EditorPaneは別sceneのInline AIがdiffShownでもexact file-backed reloadを反映する", async () => {
    const fileScene: TreeNodeData = {
      ...SCENE,
      sourceUri: "file:///workspace/scene-parity.md",
    };
    harness.storage = "file";
    harness.sceneContent = makeSceneContent("取り込み前の本文");
    useTreeStore.setState({
      nodes: [fileScene],
      scenes: [fileScene],
      activeSceneId: SCENE_ID,
    });
    const loadMock = vi.mocked(loadEditorDocument);

    render(
      <EditorPane
        nodeId={SCENE_ID}
        contentType="scene"
        groupIndex={0}
        onFocus={() => {}}
      />,
    );
    await waitFor(() => {
      expect(latestEditor("tab").state.doc.textContent).toContain(
        "取り込み前の本文",
      );
      expect(latestEditor("tab").isEditable).toBe(true);
    });
    expect(loadMock).toHaveBeenCalledTimes(1);
    expect(loadMock.mock.calls[0]?.[0]).toMatchObject({
      kind: "tree",
      id: SCENE_ID,
      storage: "file",
    });

    const otherSceneEditor = {} as TiptapEditor;
    act(() => {
      useInlineAiStore.getState().startGeneration({
        commandId: "other-scene-continue",
        mode: "insert",
        originalRange: null,
        originalText: "",
        insertPos: 0,
        abortController: new AbortController(),
        activeEditor: otherSceneEditor,
        activeEditorGroup: 1,
      });
      useInlineAiStore.getState().finishGeneration("other-scene-model");
      useExternalWriteStore.getState().bumpReloadNonce({
        kind: "tree",
        id: "different-scene",
        storage: "file",
      });
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(loadMock).toHaveBeenCalledTimes(1);

    harness.sceneContent = makeSceneContent("外部エディタで書き換えた本文");
    act(() => {
      useExternalWriteStore.getState().bumpReloadNonce({
        kind: "tree",
        id: SCENE_ID,
        storage: "file",
      });
    });

    await waitFor(() => {
      expect(latestEditor("tab").state.doc.textContent).toContain(
        "外部エディタで書き換えた本文",
      );
      expect(loadMock).toHaveBeenCalledTimes(2);
    });
    expect(useInlineAiStore.getState()).toMatchObject({
      status: "diffShown",
      activeEditor: otherSceneEditor,
      activeEditorGroup: 1,
    });
  });
});
