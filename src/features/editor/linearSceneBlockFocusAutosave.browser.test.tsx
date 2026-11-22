/**
 * LinearSceneBlock（リニア表示）の autosave でも editor が read-only にならない（EAR-1、T-4）。
 *
 * editorPaneFocusAutosave.browser.test.tsx の LinearSceneBlock 版。persistSceneBody を直接呼ぶ
 * 経路（saveEditorDocument を通らない）に `writer` が付くことと、保存中に打った分が
 * `editGenerationRef` の世代不一致で dirty のまま残り、追従保存で保存されることを、
 * 実 Chromium の実キー入力で確かめる。IO 境界（loadSceneFull ほかと native の IPC）だけが fake。
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
    baseVersion: number | undefined;
  }[],
  /** 1 なら save_scene_body_bundle の応答を待たせる。 */
  holdBundle: null as null | { release: () => void; promise: Promise<void> },
  version: 0,
  /** web 経路（saveSceneContentInner）の保存回数。 */
  webSaves: 0,
  /**
   * native の fake（T-10）。timelapse_append_batch と save_scene_body_bundle の snapshot が
   * 同じ採番器で anchor を置く。anchor は bundle の応答を放す時点の採番とする（実 native の
   * tx より後ろに取るので、hold を経ずに queue へ流れた step は「anchor 以前なのに snapshot に
   * 無い」として再生の不一致で見つかる）。
   */
  seq: 0,
  events: [] as {
    sequence: number;
    domain: string;
    opType: string;
    payload: string;
  }[],
  snapshots: [] as { anchorSequence: number; payload: unknown }[],
  /** 1 回目の bundle の応答を放した後も 2 回目で止めるための gate の列。 */
  bundleGates: [] as Array<Promise<void>>,
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

import { LinearSceneBlock } from "./LinearSceneBlock";
import { useTreeStore, type TreeNodeData } from "../tree/treeStore";
import { useProjectStore } from "../project/projectStore";
import { useEditorSessionStore } from "./editorSessionStore";
import { publishCurrentProjectId } from "@/application/project/currentProjectAuthority";
import { setCurrentWorkspaceIdentity } from "@/runtime/workspaceIdentity";
import { discardAllAutoSaves } from "@/hooks/useAutoSave";
import { _resetDocumentSaveCoordinatorForTests } from "./document/documentSaveCoordinator";
import { _resetTimelapseBodyWriteTailsForTests } from "@/features/timelapse/bodyWriteMode";
import {
  _inspectOwnSaveCapturesForTests,
  _resetRecorderForTests,
  flushStrict,
  initRecorderForProject,
  setRecorderEnabled,
} from "@/features/timelapse/recorder";
import { buildReplayStart } from "@/features/timelapse/replayStart";
import {
  replayEditorSteps,
  type ReplayEvent,
} from "@/features/timelapse/replayEngine";
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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const nextFrame = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

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
      args?: {
        payload?: { contentJson?: string; baseVersion?: number };
        events?: Array<{ domain: string; opType: string; payload: string }>;
      },
    ) => {
      h.ipc.push(cmd);
      if (cmd === "db_execute") {
        // recorder の readChainTail（T-10）。空の chain。
        return { ok: true, value: { rows: [] } };
      }
      if (cmd === "timelapse_append_batch") {
        for (const event of args?.events ?? []) {
          h.seq += 1;
          h.events.push({
            sequence: h.seq,
            domain: event.domain,
            opType: event.opType,
            payload: event.payload,
          });
        }
        return { ok: true, value: { tailSequence: h.seq } };
      }
      if (cmd === "save_scene_body_bundle") {
        const ed = h.editors.at(-1) as TiptapEditor | undefined;
        const contentJson = args?.payload?.contentJson ?? "";
        h.saves.push({
          editable: ed?.isEditable ?? true,
          active: describeActive(),
          text: ed?.state.doc.textContent ?? "",
          payloadText: contentJson,
          baseVersion: args?.payload?.baseVersion,
        });
        const gate = h.bundleGates.shift();
        if (gate) await gate;
        if (h.holdBundle) await h.holdBundle.promise;
        // 実 native は応答の前に snapshot を commit する。anchor は応答を放す時点の採番。
        if (contentJson) {
          h.snapshots.push({
            anchorSequence: h.seq,
            payload: JSON.parse(contentJson),
          });
        }
        return { ok: true, value: bundleResult() };
      }
      return { ok: true, value: null };
    },
  };
}

async function mountPane(): Promise<{ editor: TiptapEditor; pm: HTMLElement }> {
  const view = render(
    <LinearSceneBlock
      sceneId={SCENE_ID}
      scene={SCENE}
      isMounted
      isActive
      placeholderHeight={200}
      onHeightChange={() => {}}
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
  h.seq = 0;
  h.events.length = 0;
  h.snapshots.length = 0;
  h.bundleGates.length = 0;

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
  _resetRecorderForTests();
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

const KEY = { kind: "tree", id: SCENE_ID, storage: "database" } as const;
const isDirty = () => useEditorSessionStore.getState().isDocumentDirty(KEY);

describe("LinearSceneBlock の autosave と editor focus（実 Chromium）", () => {
  it("Electron の保存経路：autosave の間も editor は writable のまま、保存後も focus が残って続きの打鍵が本文に入る", async () => {
    installBridge();
    const { editor, pm } = await mountPane();
    editor.commands.focus("end");
    await nextFrame();
    expect(document.activeElement).toBe(pm);
    await userEvent.keyboard("AB");
    await waitForSaved();
    expect(h.saves).toHaveLength(1);
    expect(h.saves[0]).toMatchObject({ editable: true });
    expect(h.saves[0]!.payloadText).toContain("startAB");
    expect(document.activeElement).toBe(pm);
    await userEvent.keyboard("CD");
    expect(editor.state.doc.textContent).toBe("startABCD");
  });

  it("native の応答待ちに打った文字は本文に入り、editGeneration の世代不一致で dirty が残って、追従保存で保存される", async () => {
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
    await waitFor(() => expect(h.saves).toHaveLength(1), { timeout: 5_000 });
    expect(editor.isEditable).toBe(true);
    await userEvent.keyboard("XY");
    expect(editor.state.doc.textContent).toBe("startABXY");
    expect(isDirty()).toBe(true);
    h.holdBundle.release();
    h.holdBundle = null;
    await nextFrame();
    await nextFrame();
    // 1 回目が完了しても、窓内の入力があるので committed にならず dirty のまま。
    expect(isDirty()).toBe(true);
    expect(h.saves).toHaveLength(1);
    await waitForSaved();
    expect(h.saves).toHaveLength(2);
    expect(h.saves[0]!.payloadText).not.toContain("XY");
    expect(h.saves[1]!.payloadText).toContain("startABXY");
    // 2 回目の baseVersion は 1 回目が返した contentVersion。
    expect(h.saves[0]!.baseVersion).toBe(0);
    expect(h.saves[1]!.baseVersion).toBe(1);
  });
});

/** 最新 snapshot ＋ seq > anchor の step を再生した doc（JSON）。 */
function replayedDocJson(editor: TiptapEditor): unknown {
  const latest = h.snapshots.at(-1) ?? null;
  const events = h.events
    .filter((e) => e.domain === "editor" && e.opType === "doc.step")
    .map((e) => ({
      domain: "editor",
      opType: "doc.step",
      payload: e.payload,
      sequence: e.sequence,
    })) as ReplayEvent[];
  const start = buildReplayStart(editor.schema, events, latest);
  const result = replayEditorSteps(
    editor.schema,
    start.initialDoc,
    start.replayEvents,
  );
  expect(result.failedAt).toBeUndefined();
  return result.doc.toJSON();
}

describe("T-10：bind した recorder と実 LinearSceneBlock の結合", () => {
  const IDENTITY = {
    projectId: PROJECT_ID,
    domain: "editor",
    entityType: "scene",
    entityId: SCENE_ID,
    storage: "database",
  } as const;

  it("bundle の応答待ちに打った step は hold に入って queue へ直行せず、放流後の再生が editor の最終 doc と一致する", async () => {
    installBridge();
    setRecorderEnabled(true);
    await initRecorderForProject(PROJECT_ID);
    let releaseFirst!: () => void;
    h.holdBundle = {
      release: () => releaseFirst(),
      promise: new Promise<void>((r) => (releaseFirst = r)),
    };
    const { editor } = await mountPane();
    editor.commands.focus("end");
    await nextFrame();
    await userEvent.keyboard("AB");
    await waitFor(() => expect(h.saves).toHaveLength(1), { timeout: 5_000 });
    const beforeWindow = h.events.length;
    expect(beforeWindow).toBeGreaterThan(0);

    await userEvent.keyboard("XY");
    await sleep(400);
    const inWindow = _inspectOwnSaveCapturesForTests(IDENTITY);
    expect(inWindow.activeCaptures).toBe(1);
    expect(inWindow.heldCount).toBeGreaterThan(0);
    expect(inWindow.queueLength).toBe(0);
    expect(h.events.length).toBe(beforeWindow);
    expect(inWindow.document?.broken).toBe(false);

    let releaseSecond!: () => void;
    h.bundleGates.push(new Promise<void>((r) => (releaseSecond = r)));
    h.holdBundle = null;
    releaseFirst();
    await waitFor(() => expect(h.saves).toHaveLength(2), { timeout: 5_000 });
    expect(h.snapshots).toHaveLength(1);
    expect(JSON.stringify(h.snapshots[0]!.payload)).not.toContain("XY");
    expect(replayedDocJson(editor)).toEqual(editor.getJSON());

    releaseSecond();
    await waitForSaved();
    await flushStrict();
    expect(_inspectOwnSaveCapturesForTests(IDENTITY).activeCaptures).toBe(0);
    expect(replayedDocJson(editor)).toEqual(editor.getJSON());
  });
});
