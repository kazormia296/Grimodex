/**
 * 【製品の不具合を再現する試験】本文を打っている作者の editor focus が、autosave で body に落ちる。
 *
 * editorFocusAutosaveFence.browser.test.tsx は部品単位（useLicenseEditableSync と実 fence）だった。
 * こちらは製品の EditorPane をそのまま mount し、次を実物のまま通す。
 *   EditorPane の onUpdate → 実 useAutoSave（debounce）→ saveEditorDocument → 実 persistSceneBody
 *   （Electron の経路。window.grimodex を立てる）→ runTimelapseBodyReplacement の同期 fence
 *   → useLicenseEditableSync の setEditable(false) → 実 Chromium の focus。
 * 実物でないのは、IO 境界だけ。scene の読み込み（loadEditorDocument ほか）と、native への
 * `save_scene_body_bundle` の IPC（window.grimodex.invoke の mock）。
 *
 * 範囲：mount するのは EditorPane 単体。SceneEditor など上位の単位は通していない（コードを読んだ範囲では、
 * 上位に editable の変化で focus を戻す処理は無い。useRequestedEditorFocus は store の明示の focus 要求だけ
 * を消費する）。timelapse の recorder は既定の状態（未 bind）で、fence は enabled に関係なく取られる。
 *
 * 入力は vitest/browser の userEvent.keyboard（CDP の実キー入力）。focus を失えば文字は
 * document.body に飛ぶので、「打った文字が本文に入るか」を実際に確かめられる。
 *
 * 【不具合】と付いた試験は「今の挙動」を assert する。製品を直して focus が残るようになると、
 * これらは意図どおり失敗する。そのときは期待値を反転して回帰試験にする。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import type { Editor as TiptapEditor } from "@tiptap/core";

const SCENE_ID = "scene-focus";
const PROJECT_ID = "project-1";

const h = vi.hoisted(() => ({
  editors: [] as unknown[],
  ipc: [] as string[],
  /** save_scene_body_bundle が呼ばれた時点の editor 状態。 */
  saves: [] as {
    editable: boolean;
    active: string;
    text: string;
    payloadText: string;
  }[],
  /** 1 なら save_scene_body_bundle の応答を待たせる。 */
  holdBundle: null as null | { release: () => void; promise: Promise<void> },
  version: 0,
  /** web 経路（saveSceneContentInner）の保存回数。 */
  webSaves: 0,
}));

vi.mock("@tiptap/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tiptap/react")>();
  const { useEffect } = await import("react");
  return {
    ...actual,
    // 製品の useEditor をそのまま使い、instance だけ test から掴む。
    useEditor: (config: Record<string, unknown>, deps?: unknown[]) => {
      const editor = actual.useEditor(config as never, deps as never);
      useEffect(() => {
        if (editor && !h.editors.includes(editor)) h.editors.push(editor);
      }, [editor]);
      return editor;
    },
  };
});

vi.mock("@/features/editor/document/loadEditorDocument", () => ({
  targetFromTab: (
    _contentType: string,
    id: string,
    options?: { tree?: { nodeType?: "scene" | "note"; storage?: string } },
  ) => ({
    kind: "tree",
    id,
    nodeType: options?.tree?.nodeType ?? "scene",
    storage: options?.tree?.storage ?? "database",
  }),
  loadEditorDocument: vi.fn(async () => ({
    binding: {
      kind: "tree",
      id: SCENE_ID,
      nodeType: "scene",
      storage: "database",
      loadedVersion: 0,
    },
    content: {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "start" }] },
      ],
    },
    unplacedBeatsDoc: "[]",
    projectId: PROJECT_ID,
  })),
}));

vi.mock("@/features/editor/document/sceneSidecars", () => ({
  loadSceneSidecars: vi.fn(async () => ({
    authorshipSpans: [],
    foreshadowAnchors: [],
  })),
  applySceneSidecars: vi.fn(),
}));

vi.mock("@/features/tree/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/tree/api")>();
  return {
    ...actual,
    saveSceneContentInner: vi.fn(async () => {
      h.webSaves += 1;
      h.version += 1;
      return {
        placedBeatPreview: null,
        unplacedBeatPreview: null,
        contentVersion: h.version,
        contentUpdatedAt: new Date().toISOString(),
      };
    }),
    loadSceneFull: vi.fn(async () => ({
      content: JSON.stringify({
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "start" }] },
        ],
      }),
      unplacedBeatsDoc: "[]",
      projectId: PROJECT_ID,
      version: 0,
    })),
  };
});

vi.mock("@/features/attribution/api", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/attribution/api")>();
  return {
    ...actual,
    loadAuthorshipSpans: vi.fn(async () => []),
    saveAuthorshipSpans: vi.fn(async () => {}),
  };
});

// web（window.grimodex なし）の対照だけが使う Drizzle 経路の副作用。fence の有無には関わらない。
vi.mock("@/features/foreshadow/saveAnchors", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/foreshadow/saveAnchors")>();
  return { ...actual, saveForeshadowAnchors: vi.fn(async () => []) };
});
vi.mock("@/features/post-effect/syncAnnotations", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/features/post-effect/syncAnnotations")
    >();
  return { ...actual, saveAnnotationAnchors: vi.fn(async () => {}) };
});
vi.mock("@/features/editor/beat/mentionApi", () => ({
  upsertSceneBeatMentions: vi.fn(async () => {}),
}));
vi.mock("@/features/editor/beat/beatPovCacheApi", () => ({
  upsertSceneBeatPovOverrides: vi.fn(async () => {}),
}));

// autosave の間隔だけ短くする（既定は 2000 ms。製品の値の意味は変えない）。
vi.mock(
  "@/features/settings/hooks/useEditorSettings",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/features/settings/hooks/useEditorSettings")
      >();
    return {
      ...actual,
      useEditorSettings: () => ({
        ...actual.useEditorSettings(),
        autoSaveDelay: 300,
      }),
    };
  },
);

import { EditorPane } from "./EditorPane";
import { useTreeStore, type TreeNodeData } from "../tree/treeStore";
import { useProjectStore } from "../project/projectStore";
import { useEditorSessionStore } from "./editorSessionStore";
import { publishCurrentProjectId } from "@/application/project/currentProjectAuthority";
import { setCurrentWorkspaceIdentity } from "@/runtime/workspaceIdentity";
import { discardAllAutoSaves } from "@/hooks/useAutoSave";
import { _resetDocumentSaveCoordinatorForTests } from "./document/documentSaveCoordinator";
import { _resetTimelapseBodyWriteTailsForTests } from "@/features/timelapse/bodyWriteMode";

const SCENE: TreeNodeData = {
  id: SCENE_ID,
  projectId: PROJECT_ID,
  parentId: null,
  nodeType: "scene",
  title: "Focus Scene",
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

const nextFrame = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function latestEditor(): TiptapEditor {
  const e = h.editors.at(-1);
  if (!e) throw new Error("no editor was created");
  return e as TiptapEditor;
}

function describeActive(): string {
  const el = document.activeElement;
  if (!el) return "null";
  if (el === document.body) return "body";
  return `${el.tagName.toLowerCase()}${el.classList.contains("ProseMirror") ? ".ProseMirror" : ""}`;
}

/** save_scene_body_bundle の応答。`payload` は renderer が native へ送った本文。 */
function bundleResult() {
  h.version += 1;
  return {
    placedBeatPreview: null,
    unplacedBeatPreview: null,
    contentVersion: h.version,
    contentUpdatedAt: new Date().toISOString(),
    foreshadowRows: [],
    dbTransactionCount: 1,
  };
}

function installBridge() {
  (window as unknown as { grimodex: unknown }).grimodex = {
    shell: "electron",
    invoke: async (
      cmd: string,
      args?: { payload?: { contentJson?: string } },
    ) => {
      h.ipc.push(cmd);
      if (cmd === "save_scene_body_bundle") {
        const ed = h.editors.at(-1) as TiptapEditor | undefined;
        h.saves.push({
          editable: ed?.isEditable ?? true,
          active: describeActive(),
          text: ed?.state.doc.textContent ?? "",
          payloadText: args?.payload?.contentJson ?? "",
        });
        if (h.holdBundle) await h.holdBundle.promise;
        return { ok: true, value: bundleResult() };
      }
      return { ok: true, value: null };
    },
  };
}

async function mountPane(): Promise<{ editor: TiptapEditor; pm: HTMLElement }> {
  const view = render(
    <EditorPane
      nodeId={SCENE_ID}
      contentType="scene"
      groupIndex={0}
      onFocus={() => {}}
    />,
  );
  const pm = await waitFor(
    () => {
      const el = view.container.querySelector<HTMLElement>(".ProseMirror");
      if (!el) throw new Error("ProseMirror not mounted");
      return el;
    },
    { timeout: 10_000 },
  );
  await waitFor(
    () => {
      const ed = latestEditor();
      if (!ed.isEditable) throw new Error("editor not editable yet");
      if (ed.state.doc.textContent !== "start") throw new Error("not loaded");
    },
    { timeout: 10_000 },
  );
  return { editor: latestEditor(), pm };
}

beforeEach(() => {
  h.editors.length = 0;
  h.ipc.length = 0;
  h.saves.length = 0;
  h.holdBundle = null;
  h.version = 0;
  h.webSaves = 0;
  publishCurrentProjectId(PROJECT_ID);
  setCurrentWorkspaceIdentity({ path: "/focus.gdx", openRevision: 1 });
  useEditorSessionStore.getState().resetForProject();
  useTreeStore.setState({
    nodes: [SCENE],
    scenes: [SCENE],
    activeSceneId: SCENE_ID,
    projectId: PROJECT_ID,
    nodePreviews: {},
    charCounts: {},
  });
  useProjectStore.setState({ currentProjectId: PROJECT_ID });
});

afterEach(async () => {
  // 未保存の打鍵が残る試験があるので、unmount の flush（authority の解除後に走ると
  // genesis barrier で失敗する）と、遅れた保存が次の試験へ漏れるのを先に断つ。
  discardAllAutoSaves();
  cleanup();
  await nextFrame();
  _resetDocumentSaveCoordinatorForTests();
  _resetTimelapseBodyWriteTailsForTests();
  delete (window as unknown as { grimodex?: unknown }).grimodex;
  publishCurrentProjectId(null);
  setCurrentWorkspaceIdentity(null);
});

/** debounce（300 ms）の後の保存が commit されて dirty が解けるまで待つ。 */
async function waitForSaved() {
  await waitFor(
    () => {
      expect(
        useEditorSessionStore
          .getState()
          .isDocumentDirty({ kind: "tree", id: SCENE_ID, storage: "database" }),
      ).toBe(false);
    },
    { timeout: 5_000 },
  );
  // fence の release と描画を通す。
  await nextFrame();
  await nextFrame();
}

async function typeAndSave(
  mode: "electron" | "web",
): Promise<{ editor: TiptapEditor; pm: HTMLElement }> {
  if (mode === "electron") installBridge();
  const { editor, pm } = await mountPane();
  editor.commands.focus("end");
  await nextFrame();
  // 前提：focus は editor にあり、実キー入力が本文に入る。
  expect(document.activeElement).toBe(pm);
  await userEvent.keyboard("AB");
  expect(editor.state.doc.textContent).toBe("startAB");
  return { editor, pm };
}

describe("EditorPane の autosave と editor focus（実 Chromium）", () => {
  it("対照（web・window.grimodex なし）：autosave が走っても fence を取らず、focus が残って続きが入る", async () => {
    const { editor, pm } = await typeAndSave("web");
    await waitFor(() => expect(h.webSaves).toBeGreaterThan(0), {
      timeout: 5_000,
    });
    await waitForSaved();
    expect(h.ipc).not.toContain("save_scene_body_bundle");
    expect(editor.isEditable).toBe(true);
    expect(document.activeElement).toBe(pm);
    await userEvent.keyboard("CD");
    expect(editor.state.doc.textContent).toBe("startABCD");
  });

  it("【不具合】Electron の保存経路：autosave の間 editor は read-only になり、保存後に focus が body に落ちて続きの打鍵が本文に入らない", async () => {
    const { editor } = await typeAndSave("electron");
    await waitForSaved();
    // 保存は native bundle に 1 回届き、その時点で fence により read-only だった。
    expect(h.saves).toHaveLength(1);
    expect(h.saves[0]).toMatchObject({ editable: false });
    expect(h.saves[0]!.payloadText).toContain("startAB");
    // 解除後は editable に戻るが、focus は戻らない。
    expect(editor.isEditable).toBe(true);
    expect(describeActive()).toBe("body");
    // 続きの打鍵は本文に入らない（作者から見ると入力が止まる）。
    await userEvent.keyboard("CD");
    expect(editor.state.doc.textContent).toBe("startAB");
  });

  it("【不具合】Electron：saved 後に作者が editor を click すれば、入力は再開できる（回復の手段）", async () => {
    const { editor, pm } = await typeAndSave("electron");
    await waitForSaved();
    expect(describeActive()).toBe("body");
    await userEvent.click(pm);
    expect(document.activeElement).toBe(pm);
    await userEvent.keyboard("CD");
    expect(editor.state.doc.textContent).toContain("CD");
  });

  it("【不具合】Electron：native の応答待ち（fence の間）に打った文字は本文に入らない", async () => {
    installBridge();
    let release!: () => void;
    h.holdBundle = {
      release: () => release(),
      promise: new Promise<void>((r) => (release = r)),
    };
    const { editor } = await mountPane();
    editor.commands.focus("end");
    await nextFrame();
    await userEvent.keyboard("AB");
    // autosave が native に届き、応答を待っている間。
    await waitFor(() => expect(h.saves).toHaveLength(1), { timeout: 5_000 });
    expect(editor.isEditable).toBe(false);
    await userEvent.keyboard("XY");
    expect(editor.state.doc.textContent).toBe("startAB");
    h.holdBundle.release();
    await waitForSaved();
    // 保存された本文に XY は無い（打った文字が消えたのではなく、最初から入っていない）。
    expect(h.saves[0]!.payloadText).not.toContain("XY");
  });

  it("連続入力の最中（間隔が autosave の間隔より短い）には autosave が走らず、focus も外れない", async () => {
    installBridge();
    const { editor, pm } = await mountPane();
    editor.commands.focus("end");
    await nextFrame();
    // 300 ms の debounce より短い間隔で打ち続ける（1 打ごとに timer が再武装される）。
    for (const ch of "ABCDEFGH") {
      await userEvent.keyboard(ch);
      await sleep(120);
    }
    expect(h.saves).toHaveLength(0);
    expect(document.activeElement).toBe(pm);
    expect(editor.state.doc.textContent).toBe("startABCDEFGH");
    // 手を止めると autosave が走る（ここで focus が外れる）。
    await waitFor(() => expect(h.saves).toHaveLength(1), { timeout: 5_000 });
    await waitForSaved();
    expect(describeActive()).toBe("body");
  });
});
