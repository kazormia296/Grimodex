/**
 * 製品の不具合の回帰試験：本文を打っている作者の editor focus が、autosave で body に落ちない。
 *
 * 元の不具合（EAR-1）：Electron の autosave は persistSceneBody で replacement fence を取り、
 * useLicenseEditableSync が editor を read-only にした。実 Chromium は focus 中の要素が
 * focusable でなくなると focus を body に落とし、editable を戻しても戻らない。さらに保存の
 * 応答待ちの間に打った文字は本文に入らなかった。自分の autosave は fence も lease も取らず、
 * recorder の capture hold で履歴の順序を守るようにして直した。
 *
 * editorFocusAutosaveFence.browser.test.tsx は部品単位（useLicenseEditableSync と実 fence）だった。
 * こちらは製品の EditorPane をそのまま mount し、次を実物のまま通す。
 *   EditorPane の onUpdate → 実 useAutoSave（debounce）→ saveEditorDocument → 実 persistSceneBody
 *   （Electron の経路。window.grimodex を立てる）→ runTimelapseEditorBodyWrite の hold
 *   → useLicenseEditableSync（setEditable は呼ばれない）→ 実 Chromium の focus。
 * 実物でないのは、IO 境界だけ。scene の読み込み（loadEditorDocument ほか）と、native への
 * IPC（window.grimodex.invoke の fake。T-10 では timelapse の採番器と snapshot の anchor も
 * 同じ fake が持つ）。
 *
 * 範囲：mount するのは EditorPane 単体。SceneEditor など上位の単位は通していない（コードを読んだ範囲では、
 * 上位に editable の変化で focus を戻す処理は無い。useRequestedEditorFocus は store の明示の focus 要求だけ
 * を消費する）。T-10 以外では timelapse の recorder は既定の状態（未 bind）。
 *
 * 入力は vitest/browser の userEvent.keyboard（CDP の実キー入力）。focus を失えば文字は
 * document.body に飛ぶので、「打った文字が本文に入るか」を実際に確かめられる。
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
import { toast } from "sonner";
import { runExclusiveDocumentMutation } from "./document/documentSaveCoordinator";
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

const KEY = { kind: "tree", id: SCENE_ID, storage: "database" } as const;
const isDirty = () => useEditorSessionStore.getState().isDocumentDirty(KEY);

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

  it("Electron の保存経路：autosave の間も editor は writable のまま、保存後も focus が editor に残って続きの打鍵が本文に入る", async () => {
    const { editor, pm } = await typeAndSave("electron");
    await waitForSaved();
    // 保存は native bundle に 1 回届き、その時点でも editor は writable だった。
    expect(h.saves).toHaveLength(1);
    expect(h.saves[0]).toMatchObject({ editable: true });
    expect(h.saves[0]!.active).toBe("div.ProseMirror");
    expect(h.saves[0]!.payloadText).toContain("startAB");
    expect(editor.isEditable).toBe(true);
    expect(document.activeElement).toBe(pm);
    // 続きの打鍵が本文に入る（作者から見て入力が止まらない）。
    await userEvent.keyboard("CD");
    expect(editor.state.doc.textContent).toBe("startABCD");
  });

  it("Electron：click しなくても、autosave を何度挟んでも打ち続けられる", async () => {
    const { editor, pm } = await typeAndSave("electron");
    await waitForSaved();
    for (const chunk of ["CD", "EF"]) {
      expect(document.activeElement).toBe(pm);
      await userEvent.keyboard(chunk);
      await waitForSaved();
    }
    expect(document.activeElement).toBe(pm);
    expect(editor.state.doc.textContent).toBe("startABCDEF");
    expect(h.saves).toHaveLength(3);
    // どの保存の間も read-only にならなかった。
    expect(h.saves.every((save) => save.editable)).toBe(true);
  });

  it("Electron：native の応答待ちに打った文字は本文に入り、dirty が残って、通常の debounce の後の追従保存で保存される", async () => {
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
    expect(editor.isEditable).toBe(true);
    await userEvent.keyboard("XY");
    expect(editor.state.doc.textContent).toBe("startABXY");
    // 悪い直し（fence を残して setEditable だけ戻す）では、onUpdate の gate が
    // schedule と dirty を落として、未保存の本文が clean になる。
    expect(isDirty()).toBe(true);
    h.holdBundle.release();
    h.holdBundle = null;
    // 1 回目の保存が完了しても、窓内の入力があるので dirty のまま。
    await nextFrame();
    await nextFrame();
    expect(isDirty()).toBe(true);
    // 追従保存は背中合わせでなく、通常の debounce（300 ms）の後に走る。
    expect(h.saves).toHaveLength(1);
    await waitForSaved();
    expect(h.saves).toHaveLength(2);
    expect(h.saves[0]!.payloadText).not.toContain("XY");
    expect(h.saves[1]!.payloadText).toContain("startABXY");
    // 2 回目の baseVersion は 1 回目が返した contentVersion。
    expect(h.saves[0]!.baseVersion).toBe(0);
    expect(h.saves[1]!.baseVersion).toBe(1);
    expect(editor.state.doc.textContent).toBe("startABXY");
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
    // 手を止めると autosave が走る。editor は writable のままで focus も残る。
    await waitFor(() => expect(h.saves).toHaveLength(1), { timeout: 5_000 });
    await waitForSaved();
    expect(document.activeElement).toBe(pm);
    expect(h.saves[0]!.editable).toBe(true);
  });
});

describe("T-5：追従保存と外部置換の lease の重なり（実 EditorPane）", () => {
  it("保存中に打つ → 外部置換が lease を取る → 追従保存が拒まれても toast なしで待ち、dirty を保ち、lease が外れた後に保存される", async () => {
    installBridge();
    const toastError = vi.spyOn(toast, "error");
    let releaseBundle!: () => void;
    h.holdBundle = {
      release: () => releaseBundle(),
      promise: new Promise<void>((r) => (releaseBundle = r)),
    };
    const { editor } = await mountPane();
    editor.commands.focus("end");
    await nextFrame();
    await userEvent.keyboard("AB");
    await waitFor(() => expect(h.saves).toHaveLength(1), { timeout: 5_000 });
    await userEvent.keyboard("XY");
    expect(isDirty()).toBe(true);

    // 外部置換（revision 復元・agent 書込み・import など）が同じ文書の lease を取る。
    let finishMutation!: () => void;
    const mutation = runExclusiveDocumentMutation(
      KEY,
      () => new Promise<void>((resolve) => (finishMutation = resolve)),
      { didMutate: () => false },
    );
    await nextFrame();
    expect(editor.isEditable).toBe(false);

    // 1 回目の保存が完了し、追従保存が lease に入場を拒まれる。
    h.holdBundle = null;
    releaseBundle();
    await sleep(1200);
    expect(h.saves).toHaveLength(1);
    expect(toastError).not.toHaveBeenCalled();
    // 失敗として扱わず、打った分は dirty のまま守られる。
    expect(isDirty()).toBe(true);

    finishMutation();
    await mutation;
    await waitForSaved();
    expect(h.saves).toHaveLength(2);
    expect(h.saves[1]!.payloadText).toContain("startABXY");
    expect(toastError).not.toHaveBeenCalled();
    toastError.mockRestore();
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

describe("T-10：bind した recorder と実 EditorPane の結合（hold が実際に窓内の step を預かる）", () => {
  const IDENTITY = {
    projectId: PROJECT_ID,
    domain: "editor",
    entityType: "scene",
    entityId: SCENE_ID,
    storage: "database",
  } as const;

  it("bundle の応答待ちに打った step は hold に入って queue へ直行せず、放流後に snapshot ＋ seq > anchor の再生が editor の最終 doc と一致する", async () => {
    installBridge();
    setRecorderEnabled(true);
    await initRecorderForProject(PROJECT_ID);
    // 1 回目の bundle の応答待ち（holdBundle）と、2 回目の応答待ち（gate）。
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
    expect(editor.isEditable).toBe(true);
    // T0 より前の step（AB）は flushStrict で Native に届いている。
    const beforeWindow = h.events.length;
    expect(beforeWindow).toBeGreaterThan(0);

    // 窓の中で打つ。recorder の flush の debounce（100 ms）より長く窓を開けたままにする
    // （hold を経ずに queue へ直行した step がいれば、この間に Native へ流れて見つかる）。
    await userEvent.keyboard("XY");
    await sleep(400);
    // (c) descriptor の identity と step の key が一致し、窓内の step が実際に held に入る。
    const inWindow = _inspectOwnSaveCapturesForTests(IDENTITY);
    expect(inWindow.activeCaptures).toBe(1);
    expect(inWindow.heldCount).toBeGreaterThan(0);
    expect(inWindow.queueLength).toBe(0);
    expect(h.events.length).toBe(beforeWindow);
    // (b) hold が返す receipt で editor 側の accumulator が壊れない（recorder 側も broken でない）。
    expect(inWindow.document?.broken).toBe(false);

    // 2 回目の bundle は追従保存の中で止める（1 回目の snapshot の時点で比べるため）。
    let releaseSecond!: () => void;
    h.bundleGates.push(new Promise<void>((r) => (releaseSecond = r)));
    h.holdBundle = null;
    releaseFirst();
    await waitFor(() => expect(h.saves).toHaveLength(2), { timeout: 5_000 });
    // 1 回目の保存は完了し hold は放流済み。追従保存は 2 回目の bundle の応答待ち。
    // この時点の最新 snapshot は 1 回目（T0 ＝ startAB）で、XY は seq > anchor の step として再生される。
    expect(h.snapshots).toHaveLength(1);
    expect(JSON.stringify(h.snapshots[0]!.payload)).not.toContain("XY");
    expect(h.events.length).toBeGreaterThan(beforeWindow);
    expect(replayedDocJson(editor)).toEqual(editor.getJSON());
    expect(editor.state.doc.textContent).toBe("startABXY");

    releaseSecond();
    await waitForSaved();
    await flushStrict();
    expect(_inspectOwnSaveCapturesForTests(IDENTITY).activeCaptures).toBe(0);
    expect(replayedDocJson(editor)).toEqual(editor.getJSON());

    // 窓の後も記録が続く（accumulator が壊れていない）。
    const eventsBefore = h.events.length;
    await userEvent.keyboard("Z");
    await flushStrict();
    expect(h.events.length).toBeGreaterThan(eventsBefore);
    expect(replayedDocJson(editor)).toEqual(editor.getJSON());
  });
});
