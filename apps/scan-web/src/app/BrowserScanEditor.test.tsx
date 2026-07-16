// @vitest-environment jsdom
import type { JSONContent } from "@tiptap/core";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EditorSeedV1 } from "@grimodex/scan-contract";
import {
  BrowserWorkspaceError,
  type BrowserWorkspaceStore,
  type WorkspaceSnapshot,
  type WorkspaceSnapshotInput,
} from "../../../../src/lib/browser-db/indexedDbStore";
import { createMinimalJaSeed } from "../fixtures/minimalJa";
import { BrowserScanEditor } from "./BrowserScanEditor";
import { createBrowserScanWorkspace } from "./browserWorkspace";

const editorHarness = vi.hoisted(() => ({
  editor: undefined as
    | {
        commands: { setContent: ReturnType<typeof vi.fn> };
        getJSON: ReturnType<typeof vi.fn>;
        getText: ReturnType<typeof vi.fn>;
        setEditable: ReturnType<typeof vi.fn>;
      }
    | undefined,
  editorJson: { type: "doc", content: [] } as JSONContent,
}));

const storeHarness = vi.hoisted(() => ({
  current: undefined as BrowserWorkspaceStore | undefined,
}));

vi.mock("@tiptap/react", async () => {
  const React = await import("react");
  const editor = {
    commands: {
      setContent: vi.fn((content: JSONContent) => {
        editorHarness.editorJson = content;
      }),
    },
    getJSON: vi.fn(() => editorHarness.editorJson),
    getText: vi.fn(() => ""),
    setEditable: vi.fn(),
  };
  editorHarness.editor = editor;
  return {
    EditorContent: () =>
      React.createElement("div", { "data-testid": "tiptap-editor" }),
    useEditor: vi.fn(() => editor),
  };
});

vi.mock("@tiptap/starter-kit", () => ({ default: {} }));

vi.mock("./browserWorkspaceStore", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("./browserWorkspaceStore")>();
  return {
    ...original,
    createBrowserWorkspaceStore: () => {
      if (!storeHarness.current) throw new Error("test store is not ready");
      return storeHarness.current;
    },
  };
});

vi.mock(
  "../../../../src/features/import/scan/scanImportPlan",
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import("../../../../src/features/import/scan/scanImportPlan")
      >();
    const buildPlan = (input: unknown) => {
      const seed = input as EditorSeedV1;
      const hasScenes = seed.source.paragraphs.length > 0;
      const nodes = [
        {
          kind: "folder" as const,
          id: "folder-a",
          title: "第一章",
          children: hasScenes
            ? [
                {
                  kind: "scene" as const,
                  id: "scene-a",
                  title: "Scene A",
                  body: "A",
                },
                {
                  kind: "scene" as const,
                  id: "scene-b",
                  title: "Scene B",
                  body: "B",
                },
              ]
            : [],
        },
      ];
      return {
        schemaVersion: "grimodex-scan/import-plan/1" as const,
        importInstanceId: "browser-editor-test",
        projectTitle: seed.source.title,
        language:
          seed.source.language === "en" ? ("en" as const) : ("ja" as const),
        sourceFingerprint: seed.source.fingerprint,
        nodes,
        codexEntries: [],
        relations: [],
        phases: [],
        events: [],
        findings: [],
        idMap: {
          sections: {},
          paragraphs: {},
          entities: {},
          relations: {},
          phases: {},
          events: {},
          findings: {},
        },
        warnings: [],
      };
    };
    return {
      ...original,
      buildScanImportPlan: vi.fn(buildPlan),
      rebuildScanImportPlan: vi.fn((input: unknown) => buildPlan(input)),
    };
  },
);

vi.mock("./browserWorkspace", () => ({
  createBrowserScanWorkspace: vi.fn(
    async (plan: {
      nodes: Array<{
        kind: string;
        id: string;
        title: string;
        children?: Array<{ kind: string; id: string; title: string }>;
      }>;
    }) => {
      const scenes = plan.nodes.flatMap((folder) =>
        (folder.children ?? [])
          .filter((node) => node.kind === "scene")
          .map((scene) => ({
            id: scene.id,
            parentId: folder.id,
            title: scene.title,
            content: {
              type: "doc",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: scene.title }],
                },
              ],
            } satisfies JSONContent,
          })),
      );
      return {
        db: { close: vi.fn() },
        scenes,
        codexEntries: [],
        relations: [],
        phases: [],
        events: [],
        updateSceneContent: vi.fn(),
        exportDatabase: () => new Uint8Array([1, 2, 3]),
      };
    },
  ),
}));

interface TestStore {
  store: BrowserWorkspaceStore;
  getSnapshot(): WorkspaceSnapshot | undefined;
}

function createTestStore(
  options: {
    durability?: "persistent" | "memory";
    initialSnapshot?: WorkspaceSnapshot;
    putError?: unknown;
  } = {},
): TestStore {
  let snapshot = options.initialSnapshot;
  const metadata = (input: WorkspaceSnapshotInput) => ({
    workspaceId: input.workspaceId,
    revision: input.revision,
    schemaVersion: input.schemaVersion,
    updatedAt: input.updatedAt,
    size: input.bytes.byteLength,
  });
  const store: BrowserWorkspaceStore = {
    getDurability: () => options.durability ?? "persistent",
    put: vi.fn(async (input: WorkspaceSnapshotInput) => {
      if (options.putError) throw options.putError;
      snapshot = { ...metadata(input), bytes: new Uint8Array(input.bytes) };
      return metadata(input);
    }),
    get: vi.fn(async () => snapshot),
    getState: vi.fn(async () => snapshot),
    list: vi.fn(async () => []),
    delete: vi.fn(async () => undefined),
    rename: vi.fn(async () => undefined),
  };
  return { store, getSnapshot: () => snapshot };
}

async function flushOnPageHide(): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new Event("pagehide"));
    await Promise.resolve();
  });
}

function expectBeforeUnloadGuard(): void {
  const event = new Event("beforeunload", {
    bubbles: false,
    cancelable: true,
  });
  expect(window.dispatchEvent(event)).toBe(false);
  expect(event.defaultPrevented).toBe(true);
}

describe("BrowserScanEditor persistence regressions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    editorHarness.editorJson = { type: "doc", content: [] };
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    storeHarness.current = undefined;
  });

  it.each([
    {
      kind: "conflict",
      durability: "persistent" as const,
      putError: new BrowserWorkspaceError(
        "stale-write",
        "another tab wrote a newer revision",
      ),
    },
    {
      kind: "error",
      durability: "persistent" as const,
      putError: new Error("storage write failed"),
    },
    {
      kind: "volatile",
      durability: "memory" as const,
      putError: undefined,
    },
  ])("guards Back and beforeunload for $kind storage", async (scenario) => {
    const testStore = createTestStore(scenario);
    storeHarness.current = testStore.store;
    const onBack = vi.fn();
    const view = render(
      <BrowserScanEditor seed={createMinimalJaSeed()} onBack={onBack} />,
    );

    await waitFor(() => {
      expect(view.getByText(/保存状態: ready/u)).toBeTruthy();
    });
    if (scenario.putError) {
      await flushOnPageHide();
      await waitFor(() => {
        expect(
          view.getByText(new RegExp(`保存状態: ${scenario.kind}`, "u")),
        ).toBeTruthy();
      });
    } else {
      await waitFor(() => {
        expect(view.getByText(/永続ストレージを利用できない/u)).toBeTruthy();
      });
    }

    expectBeforeUnloadGuard();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(view.getByRole("button", { name: "レポートへ戻る" }));
    expect(confirm).toHaveBeenCalledOnce();
    expect(onBack).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    fireEvent.click(view.getByRole("button", { name: "レポートへ戻る" }));
    expect(onBack).toHaveBeenCalledOnce();
  });

  it("persists an active-scene change and restores that scene", async () => {
    const testStore = createTestStore();
    storeHarness.current = testStore.store;
    const seed = createMinimalJaSeed();
    const first = render(<BrowserScanEditor seed={seed} onBack={vi.fn()} />);

    await waitFor(() => {
      expect(first.getByText(/保存状態: ready/u)).toBeTruthy();
    });
    await flushOnPageHide();
    await waitFor(() => {
      expect(testStore.store.put).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(first.getByRole("button", { name: "Scene B" }));
    await flushOnPageHide();
    await waitFor(() => {
      expect(testStore.store.put).toHaveBeenCalledTimes(2);
    });
    const saved = testStore.getSnapshot();
    expect(saved).toBeDefined();
    const payload = JSON.parse(new TextDecoder().decode(saved?.bytes)) as {
      activeSceneId: string | null;
    };
    expect(payload.activeSceneId).toBe("scene-b");

    first.unmount();
    const restored = render(<BrowserScanEditor seed={seed} onBack={vi.fn()} />);
    await waitFor(() => {
      expect(restored.getByText(/保存状態: ready/u)).toBeTruthy();
    });
    expect(
      restored.getByRole("button", { name: "Scene B" }).className,
    ).toContain("is-active");
  });

  it("does not overwrite a corrupt stored snapshot", async () => {
    const corruptSnapshot: WorkspaceSnapshot = {
      workspaceId: "scan:corrupt",
      revision: 4,
      schemaVersion: 2,
      updatedAt: "2026-07-16T00:00:00.000Z",
      size: 8,
      bytes: new TextEncoder().encode("not-json"),
    };
    const testStore = createTestStore({ initialSnapshot: corruptSnapshot });
    storeHarness.current = testStore.store;
    const view = render(
      <BrowserScanEditor
        seed={createMinimalJaSeed()}
        workspaceId="scan:corrupt"
        onBack={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(view.getByTestId("scan-editor-workspace-error")).toBeTruthy();
    });
    await flushOnPageHide();
    view.unmount();
    expect(testStore.store.put).not.toHaveBeenCalled();
    expect(testStore.getSnapshot()?.revision).toBe(4);
    expect(testStore.getSnapshot()?.bytes).toEqual(corruptSnapshot.bytes);
  });

  it("keeps the editor disabled when the seed produces no scenes", async () => {
    const testStore = createTestStore();
    storeHarness.current = testStore.store;
    const original = createMinimalJaSeed();
    const emptySeed: EditorSeedV1 = {
      ...original,
      source: {
        ...original.source,
        paragraphs: [],
        sections: original.source.sections.map((section) => ({
          ...section,
          paragraphIds: [],
        })),
      },
    };
    const view = render(
      <BrowserScanEditor seed={emptySeed} onBack={vi.fn()} />,
    );

    await waitFor(() => {
      expect(view.getByText(/編集可能なシーンがない/u)).toBeTruthy();
    });
    expect(editorHarness.editor?.setEditable).toHaveBeenCalled();
    expect(editorHarness.editor?.setEditable).not.toHaveBeenCalledWith(true);
    expect(editorHarness.editor?.setEditable).toHaveBeenLastCalledWith(false);
  });

  it("flushes and closes its SQL.js workspace on unmount", async () => {
    const testStore = createTestStore();
    storeHarness.current = testStore.store;
    const view = render(
      <BrowserScanEditor seed={createMinimalJaSeed()} onBack={vi.fn()} />,
    );
    await waitFor(() => {
      expect(view.getByText(/保存状態: ready/u)).toBeTruthy();
    });
    const createdWorkspace = vi.mocked(createBrowserScanWorkspace).mock
      .results[0]?.value;
    const workspace = await createdWorkspace;

    view.unmount();

    await waitFor(() => {
      expect(testStore.store.put).toHaveBeenCalled();
      expect(workspace?.db.close).toHaveBeenCalledOnce();
    });
  });
});
