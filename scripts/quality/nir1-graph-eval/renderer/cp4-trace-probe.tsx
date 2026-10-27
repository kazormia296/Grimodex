/**
 * CP-4 TR：(b) の trace の page の側（DR-CP4-TR-1、TR-4）。製品の
 * `useNir1RelatedScenes` の消費者（commit を記録する。R5、`cp4-k64-probe.tsx` と同じ
 * 要約）と、製品の `EditorPane`（場面は tree の `activeSceneId` に従う。自動保存は
 * 製品のまま）を trace の間ずっと mount したまま観測する。seed は harness が渡さない
 * （hook が pin から読む。alias の stub で Graph の UI の定数だけが true になる）。
 *
 * この page が書くのは何も無い。編集は Node の側が Playwright の keyboard で製品の
 * editor に入力し、場面の切替えは tree の action `setActiveScene` で行う（どちらも
 * 製品の経路）。自動保存の commit は `subscribeSceneBodyCommits` で受け身に観測し、
 * harness は commit と次の query の間に何もしない。
 *
 * 時計はすべて renderer の `performance.now()`（R6）。待ちは page の中の 2 ms の
 * 見回りで、上限（stall の 10 s、親が返らない場合の guard）は Node の側が渡す。
 */
import { createElement, useLayoutEffect, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useNir1RelatedScenes } from "@/features/related-scenes/useNir1RelatedScenes";
import {
  listenRelatedScenesGraphReady,
  listenRelatedScenesIndexReady,
} from "@/features/related-scenes/nir1RelatedScenesApi";
import { useTreeStore } from "@/features/tree/treeStore";
import { getSceneVersion } from "@/features/tree/api";
import { subscribeSceneBodyCommits } from "@/lib/sceneBodyCommitRegistry";
import type { FetchTimingRow } from "./fetchRelatedScenes.timing";
import { displayKey, summarize } from "./cp4-k64-probe";
import {
  cycleEndOf,
  publishedOf,
  selectCountedFetch,
  type TraceFetchRow,
} from "./trace-cycle";

/** The pure rules' view of the timing shim's rows (trace-cycle.ts). */
function cycleRows(): TraceFetchRow[] {
  return fetchRows.map((row) => ({
    seq: row.seq,
    sceneId: row.sceneId,
    refreshTrigger: row.refreshTrigger,
    calledAt: row.calledAt,
    resolvedAt: row.resolvedAt,
    status: row.value?.status ?? null,
    tRawReadyMs: row.value?.timing.tRawReadyMs ?? null,
  }));
}

interface ApiRow {
  cmd: string;
  calledAt: number;
  resolvedAt: number | null;
  ok: boolean | null;
  settle: string | null;
  status: string | null;
  reason: string | null;
}

interface Commit {
  at: number;
  fetchSeq: number | null;
  loading: boolean;
  display: string | null;
}

const host = globalThis as unknown as {
  __cp4IpcTiming?: ApiRow[];
  __cp4FetchTiming?: FetchTimingRow[];
  __cp4FetchSeq?: WeakMap<object, number>;
};
const apiRows = (host.__cp4IpcTiming ??= []);
const fetchRows = (host.__cp4FetchTiming ??= []);
const seqOf = (host.__cp4FetchSeq ??= new WeakMap<object, number>());

const notices: {
  kind: "graph-ready" | "index-ready";
  projectId: string;
  at: number;
}[] = [];
const bodyCommits: { at: number; sceneId: string; contentVersion: number }[] =
  [];
const commits: Commit[] = [];
let listening: Promise<unknown> | null = null;
let unsubscribeCommits: (() => void) | null = null;
let root: Root | null = null;
let container: HTMLElement | null = null;
let mounted: {
  projectId: string;
  sceneId: string;
  mountedAt: number;
  initialVersion: number;
} | null = null;

function listen() {
  listening ??= Promise.all([
    listenRelatedScenesGraphReady((projectId) =>
      notices.push({ kind: "graph-ready", projectId, at: performance.now() }),
    ),
    listenRelatedScenesIndexReady((projectId) =>
      notices.push({ kind: "index-ready", projectId, at: performance.now() }),
    ),
  ]);
  return listening;
}

interface EditorProps {
  nodeId: string;
  contentType: "scene";
  groupIndex: 0;
  onFocus: () => void;
  inputProjectionAuthority: "workspace";
  inputProjectionScopeKey: string;
  isForegroundInputProjection: boolean;
}

function TraceRoot({
  Editor,
  scopeKey,
}: {
  Editor: ComponentType<EditorProps>;
  scopeKey: string;
}) {
  const { fetch, loading } = useNir1RelatedScenes(true);
  const sceneId = useTreeStore((state) => state.activeSceneId);
  useLayoutEffect(() => {
    commits.push({
      at: performance.now(),
      fetchSeq: fetch ? (seqOf.get(fetch) ?? -1) : null,
      loading,
      display: fetch ? displayKey(fetch) : null,
    });
  }, [fetch, loading]);
  return createElement(
    "div",
    { "data-cp4-trace-editor": "", style: { width: 900, height: 700 } },
    sceneId
      ? createElement(Editor, {
          nodeId: sceneId,
          contentType: "scene",
          groupIndex: 0,
          onFocus: () => {},
          inputProjectionAuthority: "workspace",
          inputProjectionScopeKey: scopeKey,
          isForegroundInputProjection: true,
        })
      : null,
  );
}

/**
 * Mounts the hook consumer and the product editor on the query Scene. The
 * Scene's version is read before the mount (not inside the trace). The
 * editor modules and the product i18n are imported here only, so the other
 * harness entries keep their module graph behaviour.
 */
async function mount(input: {
  projectId: string;
  sceneId: string;
  workspacePath: string;
}) {
  if (root) throw new Error("the trace page is already mounted");
  await listen();
  const [{ EditorPane }, , { createEditorInputScopeKey }, workspace] =
    await Promise.all([
      import("@/features/editor/EditorPane"),
      import("@/lib/i18n"),
      import("@/features/editor/editorInputReady"),
      import("@/runtime/workspaceIdentity"),
    ]);
  apiRows.length = 0;
  fetchRows.length = 0;
  notices.length = 0;
  bodyCommits.length = 0;
  commits.length = 0;
  unsubscribeCommits?.();
  unsubscribeCommits = subscribeSceneBodyCommits((publication) => {
    if (publication.projectId !== input.projectId) return;
    bodyCommits.push({
      at: performance.now(),
      sceneId: publication.sceneId,
      contentVersion: publication.contentVersion,
    });
  });
  const initialVersion = await getSceneVersion(input.sceneId);
  useTreeStore.getState().setActiveScene(input.sceneId);
  const identity = workspace.getCurrentWorkspaceIdentity();
  const scopeKey = createEditorInputScopeKey({
    projectId: input.projectId,
    workspacePath: identity?.path ?? input.workspacePath,
    workspaceOpenRevision: identity?.openRevision ?? 1,
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const mountedAt = performance.now();
  root.render(
    createElement(TraceRoot, {
      Editor: EditorPane as unknown as ComponentType<EditorProps>,
      scopeKey,
    }),
  );
  mounted = {
    projectId: input.projectId,
    sceneId: input.sceneId,
    mountedAt,
    initialVersion,
  };
  return { mountedAt, initialVersion };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function editorElement(): HTMLElement | null {
  return (
    container?.querySelector<HTMLElement>(
      '.ProseMirror[contenteditable="true"]',
    ) ?? null
  );
}

/** Waits for the product editor of the active Scene to be editable. */
async function awaitEditor(input: { limitMs: number }) {
  const started = performance.now();
  for (;;) {
    const element = editorElement();
    if (element) return { ok: true, at: performance.now() };
    if (performance.now() - started >= input.limitMs)
      return { ok: false, stalled: "editor-not-editable" };
    await sleep(2);
  }
}

/** Focuses the editor (the caret goes to the end with Control+End from Node). */
function focusEditor() {
  const element = editorElement();
  if (!element) return { ok: false, error: "no editable editor" };
  element.focus();
  return { ok: true, at: performance.now() };
}

function editorText() {
  return editorElement()?.textContent ?? null;
}

/** The first autosave commit of the Scene after `sinceAt`. */
async function awaitBodyCommit(input: {
  sceneId: string;
  sinceAt: number;
  limitMs: number;
}) {
  const started = performance.now();
  for (;;) {
    const commit = bodyCommits.find(
      (row) => row.sceneId === input.sceneId && row.at > input.sinceAt,
    );
    if (commit) return { ok: true, ...commit };
    if (performance.now() - started >= input.limitMs)
      return { ok: false, stalled: "no-autosave-commit" };
    await sleep(2);
  }
}

/**
 * The product's own query after the operation: the first fetch of the Scene
 * called at or after `sinceAt`, after `afterSeq`, without the `graph-ready`
 * mark.
 */
async function awaitCounted(input: {
  sceneId: string;
  afterSeq: number;
  sinceAt: number;
  limitMs: number;
}) {
  const started = performance.now();
  for (;;) {
    const row = selectCountedFetch(cycleRows(), input);
    if (row)
      return {
        ok: true,
        seq: row.seq,
        calledAt: row.calledAt,
        seed: fetchRows.find((fetch) => fetch.seq === row.seq)?.seed ?? null,
      };
    if (performance.now() - started >= input.limitMs)
      return { ok: false, stalled: "no-product-query" };
    await sleep(2);
  }
}

/**
 * S2 `cycleEnd`: the parent's next `graph-ready` refresh published, the
 * parent's `t_raw_ready` + T_show, or the session stopped (a parent or child
 * that did not complete). `limitMs` guards a parent that never returns.
 */
async function awaitCycleEnd(input: {
  parentSeq: number;
  tShowMs: number;
  limitMs: number;
}) {
  const started = performance.now();
  for (;;) {
    await sleep(2);
    const now = performance.now();
    const reason = cycleEndOf(cycleRows(), commits, {
      parentSeq: input.parentSeq,
      tShowMs: input.tShowMs,
      now,
      elapsedMs: now - started,
      limitMs: input.limitMs,
    });
    if (reason !== null)
      return {
        reason,
        at: performance.now(),
        lastSeq: fetchRows.at(-1)?.seq ?? 0,
      };
  }
}

/** The Scene the tree action selects (S2 browsing: 製品の tree の操作). */
function navigate(input: { sceneId: string }) {
  useTreeStore.getState().setActiveScene(input.sceneId);
  return { ok: true, at: performance.now() };
}

/** S2 `until: query-published`: the Scene's query after `sinceAt` is shown. */
async function awaitPublished(input: {
  sceneId: string;
  sinceAt: number;
  limitMs: number;
}) {
  const started = performance.now();
  for (;;) {
    const shown = publishedOf(cycleRows(), commits, {
      sceneId: input.sceneId,
      sinceAt: input.sinceAt,
      now: performance.now(),
    });
    if (shown) return { ok: true, ...shown };
    if (performance.now() - started >= input.limitMs)
      return { ok: false, stalled: "no-query-published" };
    await sleep(2);
  }
}

/** Everything observed since the mount (k64-record.mjs's shapes). */
function exportObservation() {
  return {
    mounted,
    observedUntil: performance.now(),
    initialVersion: mounted?.initialVersion ?? null,
    fetches: fetchRows.map((row) => ({
      seq: row.seq,
      sceneId: row.sceneId,
      queryGeneration: row.queryGeneration,
      refreshTrigger: row.refreshTrigger,
      seed: row.seed,
      rawOnly: row.rawOnly,
      calledAt: row.calledAt,
      resolvedAt: row.resolvedAt,
      failed: row.failed,
      result: row.value ? summarize(row.value, row.sceneId) : null,
    })),
    commits: [...commits],
    notices: notices
      .filter((row) => row.projectId === mounted?.projectId)
      .map(({ kind, at }) => ({ kind, at })),
    bodyCommits: [...bodyCommits],
    api: apiRows.map((row, id) => ({
      id,
      cmd: row.cmd,
      calledAt: row.calledAt,
      resolvedAt: row.resolvedAt,
      ok: row.ok,
      settle: row.settle,
      status: row.status,
      reason: row.reason,
    })),
  };
}

function unmount() {
  root?.unmount();
  container?.remove();
  unsubscribeCommits?.();
  unsubscribeCommits = null;
  root = null;
  container = null;
  return { ok: true, at: performance.now() };
}

export const traceProbe = {
  mount,
  awaitEditor,
  focusEditor,
  editorText,
  awaitBodyCommit,
  awaitCounted,
  awaitCycleEnd,
  navigate,
  awaitPublished,
  exportObservation,
  unmount,
  now: () => performance.now(),
};
