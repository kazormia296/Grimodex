/**
 * 伏線 mark の baseVersion の更新を「遅らせて必ず適用する」（EAR-7、起案 T-8、実 Chromium）。
 *
 * 自分の autosave は editor を read-only にしないので、保存の応答が返ったとき・次の保存の T0 の
 * ときに、作者が日本語の変換中のことがある。mark の `baseVersion` は次回保存の OCC token そのもの
 * （Native は anchor が変わったとき `current_version == expected` を要求し、合わなければ
 * FORESHADOW_VERSION_MISMATCH で tx ごと失敗する）なので、更新を捨てると追従保存が失敗し続ける。
 *
 * 実物：EditorPane／LinearSceneBlock、実 useAutoSave、実 persistSceneBody、実 pendingForeshadowRefresh、
 * 実 Chromium の実キー入力と CompositionEvent。fake：IO 境界だけ。native の fake は伏線の
 * 楽観ロックを再現する（anchor の位置が変わった保存で、payload の baseVersion が現在の version と
 * 違えば FORESHADOW_VERSION_MISMATCH。変わったら version を 1 進めて row を返す）。
 *
 * IME：repo に実 IME の試験は無い。ここは合成の CompositionEvent（compositionstart／end）で
 * ProseMirror の `view.composing` を立てる。実機の IME（候補選択・確定の順序）は未確認。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import type { Editor as TiptapEditor } from "@tiptap/core";

const SCENE_ID = "scene-focus";
const PROJECT_ID = "project-1";

const h = vi.hoisted(() => ({
  editors: [] as unknown[],
  saves: [] as {
    baseVersion: number | undefined;
    fsBaseVersion: number | undefined;
    payloadText: string;
  }[],
  holdBundle: null as null | { release: () => void; promise: Promise<void> },
  /** scene body の version（contentVersion）。 */
  version: 0,
  /** native の fake が持つ伏線の現在の version と anchor。 */
  fs: {
    version: 1,
    anchor: "1:6",
    from: 1,
    to: 6,
    /** 直近に保存された本文（再ロードの試験が読む）。 */
    savedContent: null as unknown,
  },
  mismatches: 0,
  /** timelapse の fake（再生の一致を見る試験）。 */
  seq: 0,
  events: [] as {
    sequence: number;
    domain: string;
    opType: string;
    payload: string;
  }[],
  snapshots: [] as { anchorSequence: number; payload: unknown }[],
}));

vi.mock("@tiptap/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tiptap/react")>();
  const { useEffect } = await import("react");
  return {
    ...actual,
    useEditor: (config: Record<string, unknown>, deps?: unknown[]) => {
      const editor = actual.useEditor(config as never, deps as never);
      useEffect(() => {
        if (editor && !h.editors.includes(editor)) h.editors.push(editor);
      }, [editor]);
      return editor;
    },
  };
});

const markedDoc = (text: string, version: number) => ({
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        {
          type: "text",
          text,
          marks: [
            {
              type: "foreshadowSetup",
              attrs: {
                setupId: "setup-1",
                foreshadowId: "fs-1",
                baseVersion: version,
              },
            },
          ],
        },
      ],
    },
  ],
});

/** 初回は印の無い "start"（EditorPane は sidecar が印を付ける）。再ロードは直近の保存の本文。 */
const plainContent = () =>
  (h.fs.savedContent as object | null) ?? {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "start" }] },
    ],
  };

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
      loadedVersion: h.version,
    },
    content: plainContent(),
    unplacedBeatsDoc: "[]",
    projectId: PROJECT_ID,
  })),
}));

// 実 applySceneSidecars を使い、DB（fake）の anchor と version から印を付ける。
vi.mock("@/features/editor/document/sceneSidecars", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/features/editor/document/sceneSidecars")
    >();
  return {
    ...actual,
    loadSceneSidecars: vi.fn(async () => ({
      spans: [],
      annotations: null,
      errors: [],
      foreshadowMarks: [
        {
          from: h.fs.from,
          to: h.fs.to,
          markName: "foreshadowSetup",
          attrs: {
            setupId: "setup-1",
            foreshadowId: "fs-1",
            baseVersion: h.fs.version,
          },
        },
      ],
    })),
  };
});

vi.mock("@/features/tree/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/tree/api")>();
  return {
    ...actual,
    // LinearSceneBlock の load。印は本文に入れて返す（Linear は sidecar を使わない）。
    loadSceneFull: vi.fn(async () => ({
      content: JSON.stringify(markedDoc("start", h.fs.version)),
      unplacedBeatsDoc: "[]",
      projectId: PROJECT_ID,
      version: h.version,
    })),
    getSceneVersion: vi.fn(async () => h.version),
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
vi.mock("@/features/editor/beat/mentionApi", () => ({
  upsertSceneBeatMentions: vi.fn(async () => {}),
}));
vi.mock("@/features/editor/beat/beatPovCacheApi", () => ({
  upsertSceneBeatPovOverrides: vi.fn(async () => {}),
}));
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
import { LinearSceneBlock } from "./LinearSceneBlock";
import { useTreeStore, type TreeNodeData } from "../tree/treeStore";
import { useProjectStore } from "../project/projectStore";
import { useEditorSessionStore } from "./editorSessionStore";
import { announcePersistedBinding, saveScene } from "./editorSaveRegistry";
import { hasPendingForeshadowRefresh } from "./pendingForeshadowRefresh";
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
import { toast } from "sonner";

const SCENE: TreeNodeData = {
  id: SCENE_ID,
  projectId: PROJECT_ID,
  parentId: null,
  nodeType: "scene",
  title: "Foreshadow Scene",
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

/**
 * 保存・伏線に関わる失敗の toast。無関係の toast（この試験の mock の範囲で出る付箋の読込み
 * 失敗）だけを除いて数える。文言に依らず、保存の失敗の別の文言も素通りさせない。
 */
const saveFailures = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.filter((call) => !/付箋|sticky/i.test(String(call[0])));

const KEY = { kind: "tree", id: SCENE_ID, storage: "database" } as const;
const isDirty = () => useEditorSessionStore.getState().isDocumentDirty(KEY);
const nextFrame = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function latestEditor(): TiptapEditor {
  const e = h.editors.at(-1);
  if (!e) throw new Error("no editor was created");
  return e as TiptapEditor;
}

/** editor の doc にある伏線 mark の baseVersion。 */
function markBaseVersion(editor: TiptapEditor): number | null {
  let found: number | null = null;
  editor.state.doc.descendants((node) => {
    for (const mark of node.marks) {
      if (mark.type.name === "foreshadowSetup") {
        found = mark.attrs.baseVersion as number;
      }
    }
  });
  return found;
}

function installBridge() {
  (window as unknown as { grimodex: unknown }).grimodex = {
    shell: "electron",
    invoke: async (
      cmd: string,
      args?: {
        payload?: {
          contentJson?: string;
          baseVersion?: number;
          foreshadowSetups?: Array<{
            foreshadowId: string;
            baseVersion: number;
            fromPos: number;
            toPos: number;
          }>;
        };
        events?: Array<{ domain: string; opType: string; payload: string }>;
      },
    ) => {
      if (cmd === "db_execute") return { ok: true, value: { rows: [] } };
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
        const payload = args?.payload ?? {};
        const setup = payload.foreshadowSetups?.[0];
        h.saves.push({
          baseVersion: payload.baseVersion,
          fsBaseVersion: setup?.baseVersion,
          payloadText: payload.contentJson ?? "",
        });
        const rows: unknown[] = [];
        if (setup) {
          const key = `${setup.fromPos}:${setup.toPos}`;
          if (key !== h.fs.anchor) {
            // anchor が変わった保存だけが楽観ロックの対象（Native の finish_foreshadow_child_write）。
            if (setup.baseVersion !== h.fs.version) {
              h.mismatches += 1;
              return {
                ok: false,
                error: `FORESHADOW_VERSION_MISMATCH: expected ${h.fs.version}, got ${setup.baseVersion}`,
              };
            }
            h.fs.version += 1;
            h.fs.anchor = key;
            h.fs.from = setup.fromPos;
            h.fs.to = setup.toPos;
            rows.push({ id: setup.foreshadowId, version: h.fs.version });
          }
        }
        if (payload.contentJson) {
          h.fs.savedContent = JSON.parse(payload.contentJson);
        }
        if (h.holdBundle) await h.holdBundle.promise;
        if (payload.contentJson) {
          h.snapshots.push({
            anchorSequence: h.seq,
            payload: JSON.parse(payload.contentJson),
          });
        }
        h.version += 1;
        return {
          ok: true,
          value: {
            placedBeatPreview: null,
            unplacedBeatPreview: null,
            contentVersion: h.version,
            contentUpdatedAt: new Date().toISOString(),
            foreshadowRows: rows,
            dbTransactionCount: 1,
          },
        };
      }
      return { ok: true, value: null };
    },
  };
}

type Surface = "pane" | "linear";

async function mountSurface(
  surface: Surface,
): Promise<{ editor: TiptapEditor; pm: HTMLElement }> {
  const view = render(
    surface === "pane" ? (
      <EditorPane
        nodeId={SCENE_ID}
        contentType="scene"
        groupIndex={0}
        onFocus={() => {}}
      />
    ) : (
      <LinearSceneBlock
        sceneId={SCENE_ID}
        scene={SCENE}
        isMounted
        isActive
        placeholderHeight={200}
        onHeightChange={() => {}}
        onFocus={() => {}}
      />
    ),
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
      if (!ed.state.doc.textContent.endsWith("start")) {
        throw new Error("not loaded");
      }
      if (markBaseVersion(ed) === null) throw new Error("marks not applied");
    },
    { timeout: 10_000 },
  );
  return { editor: latestEditor(), pm };
}

beforeEach(() => {
  h.editors.length = 0;
  h.saves.length = 0;
  h.holdBundle = null;
  h.version = 0;
  h.fs.version = 1;
  h.fs.anchor = "1:6";
  h.fs.from = 1;
  h.fs.to = 6;
  h.fs.savedContent = null;
  h.mismatches = 0;
  h.seq = 0;
  h.events.length = 0;
  h.snapshots.length = 0;
  publishCurrentProjectId(PROJECT_ID);
  setCurrentWorkspaceIdentity({ path: "/foreshadow.gdx", openRevision: 1 });
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
  discardAllAutoSaves();
  cleanup();
  await nextFrame();
  _resetDocumentSaveCoordinatorForTests();
  _resetTimelapseBodyWriteTailsForTests();
  _resetRecorderForTests();
  delete (window as unknown as { grimodex?: unknown }).grimodex;
  publishCurrentProjectId(null);
  setCurrentWorkspaceIdentity(null);
  vi.restoreAllMocks();
});

async function waitForSaved() {
  await waitFor(() => expect(isDirty()).toBe(false), { timeout: 8_000 });
  await nextFrame();
  await nextFrame();
}

/** bundle の応答を止めて、1 回目の保存が native に届くまで進める。 */
async function startHeldFirstSave(editor: TiptapEditor): Promise<() => void> {
  let release!: () => void;
  h.holdBundle = {
    release: () => release(),
    promise: new Promise<void>((r) => (release = r)),
  };
  editor.commands.focus("start");
  await nextFrame();
  await userEvent.keyboard("AB");
  await waitFor(() => expect(h.saves).toHaveLength(1), { timeout: 5_000 });
  return () => {
    h.holdBundle = null;
    release();
  };
}

function startComposition(pm: HTMLElement, editor: TiptapEditor) {
  pm.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
  expect(editor.view.composing).toBe(true);
}
function endComposition(pm: HTMLElement) {
  pm.dispatchEvent(new CompositionEvent("compositionend", { data: "" }));
}

describe.each<[string, Surface]>([
  ["EditorPane", "pane"],
  ["LinearSceneBlock", "linear"],
])("伏線 mark の遅延適用（%s）", (_name, surface) => {
  it("(a) 保存中に mark より前へ打つと、追従保存は FORESHADOW_VERSION_MISMATCH にならず、2 回目の baseVersion が 1 回目の返り値になる", async () => {
    installBridge();
    const toastError = vi.spyOn(toast, "error");
    const { editor } = await mountSurface(surface);
    const release = await startHeldFirstSave(editor);
    await userEvent.keyboard("XY");
    expect(isDirty()).toBe(true);
    release();
    await waitForSaved();

    expect(h.mismatches).toBe(0);
    expect(saveFailures(toastError)).toEqual([]);
    // 1 回目は version 1 の mark で保存し、native が anchor の変更で version 2 を返した。
    expect(h.saves[0]!.fsBaseVersion).toBe(1);
    expect(h.saves[1]!.fsBaseVersion).toBe(2);
    expect(markBaseVersion(editor)).toBe(h.fs.version);
    expect(editor.state.doc.textContent).toBe("ABXYstart");
    // (h)(1) mark 更新の dispatch が onUpdate で dirty を立て、更新後の baseVersion を保存済みの
    // 本文へ書き戻す追従保存が 1 回余分に走りうる（web 経路と同じ。EditorPane で実測）。
    // version が変わらなければそこで止まる：連鎖せず、有界の回数で静止する。
    await sleep(1500);
    const settled = h.saves.length;
    expect(settled).toBeLessThanOrEqual(4);
    await sleep(1500);
    expect(h.saves).toHaveLength(settled);
    expect(h.mismatches).toBe(0);
  });

  it("(b)(c) 変換中に保存結果が返ると適用せず pending に残し、変換が続く間の背景の保存は延期され（native 呼び出し 0 回）、変換が終わると 1 回だけ保存して baseVersion が最新", async () => {
    installBridge();
    const toastError = vi.spyOn(toast, "error");
    const { editor, pm } = await mountSurface(surface);
    const release = await startHeldFirstSave(editor);
    await userEvent.keyboard("XY");
    startComposition(pm, editor);

    release();
    // 保存結果が返っても、変換中なので mark の baseVersion は古いまま（dispatch しない）。
    await waitFor(
      () => expect(hasPendingForeshadowRefresh(editor)).toBe(true),
      {
        timeout: 3_000,
      },
    );
    expect(markBaseVersion(editor)).toBe(1);
    expect(h.fs.version).toBe(2);

    // 変換が続く間、背景の保存は延期され続ける（native を呼ばない・失敗にもならない）。
    await sleep(1500);
    expect(h.saves).toHaveLength(1);
    expect(h.mismatches).toBe(0);
    expect(saveFailures(toastError)).toEqual([]);
    expect(isDirty()).toBe(true);

    // 変換が終わる（compositionend の次の task）と pending が適用され、保存が走る。
    endComposition(pm);
    await waitFor(
      () => expect(hasPendingForeshadowRefresh(editor)).toBe(false),
      {
        timeout: 3_000,
      },
    );
    await waitForSaved();
    expect(h.mismatches).toBe(0);
    expect(h.saves[1]!.fsBaseVersion).toBe(2);
    expect(markBaseVersion(editor)).toBe(h.fs.version);
    expect(saveFailures(toastError)).toEqual([]);
  });

  it("(b) blur でも pending が適用される（変換中でなければ）", async () => {
    installBridge();
    const { editor, pm } = await mountSurface(surface);
    const release = await startHeldFirstSave(editor);
    startComposition(pm, editor);
    release();
    await waitFor(
      () => expect(hasPendingForeshadowRefresh(editor)).toBe(true),
      {
        timeout: 3_000,
      },
    );
    // 変換を（compositionend を出さずに）終わらせてから blur する。
    (
      editor.view as unknown as { input: { composing: boolean } }
    ).input.composing = false;
    pm.blur();
    await nextFrame();
    expect(hasPendingForeshadowRefresh(editor)).toBe(false);
    expect(markBaseVersion(editor)).toBe(2);
  });

  it("(d) flush（手動保存・閉じる・切替）は変換中でも延期せず、composition を確定させて適用し、保存が通る", async () => {
    installBridge();
    const toastError = vi.spyOn(toast, "error");
    const { editor, pm } = await mountSurface(surface);
    const release = await startHeldFirstSave(editor);
    await userEvent.keyboard("XY");
    startComposition(pm, editor);
    release();
    await waitFor(
      () => expect(hasPendingForeshadowRefresh(editor)).toBe(true),
      {
        timeout: 3_000,
      },
    );
    expect(h.saves).toHaveLength(1);

    // 変換が続いたまま flush。
    await saveScene(SCENE_ID);
    expect(h.saves).toHaveLength(2);
    expect(h.mismatches).toBe(0);
    expect(h.saves[1]!.fsBaseVersion).toBe(2);
    // 変換がまだ続いているので、2 回目の保存結果（version 3）はまた pending に残る。
    expect(markBaseVersion(editor)).toBe(2);
    expect(hasPendingForeshadowRefresh(editor)).toBe(true);
    expect(saveFailures(toastError)).toEqual([]);
    // 変換が終われば適用される。
    endComposition(pm);
    await waitFor(() => expect(markBaseVersion(editor)).toBe(h.fs.version), {
      timeout: 3_000,
    });
  });

  it("(d) 閉じる（unmount の flush）も、変換中で pending が残っていても延期せず、古い baseVersion で FORESHADOW_VERSION_MISMATCH にならない", async () => {
    installBridge();
    const { editor, pm } = await mountSurface(surface);
    const release = await startHeldFirstSave(editor);
    await userEvent.keyboard("XY");
    startComposition(pm, editor);
    release();
    await waitFor(
      () => expect(hasPendingForeshadowRefresh(editor)).toBe(true),
      {
        timeout: 3_000,
      },
    );
    expect(h.saves).toHaveLength(1);

    // 変換が続いたまま editor を閉じる（unmount の flush が未保存の本文を保存する）。
    cleanup();
    await waitFor(() => expect(h.saves.length).toBeGreaterThanOrEqual(2), {
      timeout: 5_000,
    });
    expect(h.mismatches).toBe(0);
    expect(h.saves[1]!.fsBaseVersion).toBe(2);
    expect(h.saves[1]!.payloadText).toContain("XY");
  });

  it("(e) pending が無い通常の保存は、従来どおり保存結果の直後に適用される（回帰）", async () => {
    installBridge();
    const { editor } = await mountSurface(surface);
    editor.commands.focus("start");
    await nextFrame();
    await userEvent.keyboard("AB");
    await waitForSaved();
    expect(hasPendingForeshadowRefresh(editor)).toBe(false);
    expect(h.saves[0]!.fsBaseVersion).toBe(1);
    expect(markBaseVersion(editor)).toBe(2);
    expect(h.mismatches).toBe(0);
  });
});

describe("peer の保存の通知は変換中に setContent せず、変換が終わった後に処理し直す（EditorPane）", () => {
  it("変換中は本文を差し替えず、compositionend の後に差し替える", async () => {
    installBridge();
    const { editor, pm } = await mountSurface("pane");
    editor.commands.focus("start");
    await nextFrame();
    startComposition(pm, editor);
    const peerDoc = markedDoc("peer text", h.fs.version);
    announcePersistedBinding(
      KEY,
      "other-instance" as never,
      {
        kind: "tree",
        id: SCENE_ID,
        nodeType: "scene",
        storage: "database",
        loadedVersion: 5,
      },
      peerDoc,
    );
    await nextFrame();
    expect(editor.state.doc.textContent).toBe("start");
    endComposition(pm);
    await waitFor(
      () => expect(editor.state.doc.textContent).toBe("peer text"),
      {
        timeout: 3_000,
      },
    );
  });
});

describe("(h) mark 更新の dispatch の扱い（guard の要否の実測、EditorPane）", () => {
  it("(2) 保存 → 再ロード（開き直し）→ mark の前に打って保存しても FORESHADOW_VERSION_MISMATCH にならない（再ロードが DB の version で印を付け直す）", async () => {
    installBridge();
    const first = await mountSurface("pane");
    first.editor.commands.focus("start");
    await nextFrame();
    await userEvent.keyboard("AB");
    await waitForSaved();
    expect(h.fs.version).toBe(2);
    // 閉じて、直近の保存の本文（印の baseVersion は保存時点の値）で開き直す。
    cleanup();
    await nextFrame();
    h.editors.length = 0;
    const savesBefore = h.saves.length;
    const second = await mountSurface("pane");
    // 再ロードは DB の version（sidecar）で印を付け直している。
    expect(markBaseVersion(second.editor)).toBe(h.fs.version);
    second.editor.commands.focus("start");
    await nextFrame();
    await userEvent.keyboard("CD");
    await waitForSaved();
    expect(h.mismatches).toBe(0);
    expect(h.saves.length).toBeGreaterThan(savesBefore);
    expect(h.saves[savesBefore]!.fsBaseVersion).toBe(2);
  });

  it("(3) mark 更新の dispatch は doc.step として履歴に記録され、再生が editor の最終 doc（更新後の baseVersion を含む）と一致する", async () => {
    installBridge();
    setRecorderEnabled(true);
    await initRecorderForProject(PROJECT_ID);
    const { editor } = await mountSurface("pane");
    editor.commands.focus("start");
    await nextFrame();
    await userEvent.keyboard("AB");
    await waitForSaved();
    await flushStrict();
    expect(_inspectOwnSaveCapturesForTests().activeCaptures).toBe(0);
    expect(markBaseVersion(editor)).toBe(2);

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
    expect(result.doc.toJSON()).toEqual(editor.getJSON());
  });
});
