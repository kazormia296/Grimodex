/**
 * 断片（SnippetDetailContent）の autosave でも editor が read-only にならない（EAR-12、T-11 (d)）。
 *
 * 以前は断片の本文保存が replacement fence（`runTimelapseBodyReplacement`／`runTimelapseBodyWrite`）
 * を取り、保存の間 editor が read-only になって focus が落ち、保存中に打った文字が失われた。
 * いまは `saveFn` が `getHTML()` と同じ同期区間で capture hold を開き、store 経由で
 * `updateSnippet` が `runTimelapseEditorBodyWrite` で引き取る。
 *
 * 実 Chromium の実キー入力で、(1) 保存の間も editor は writable のまま focus が残り、
 * (2) 保存中に打った文字が本文に入って dirty が残り追従保存で保存され、
 * (3) その間の doc.step が hold に入ること（recorder を bind）を確かめる。
 * `updateSnippet` に isElectron の分岐はなく、web でも同じ経路を通る（fence から
 * hold への変更は web にも及ぶ）。IO 境界（native の IPC と DB 読み）だけが fake。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import type { Editor as TiptapEditor } from "@tiptap/core";
import { getTableColumns } from "drizzle-orm";

const SNIPPET_ID = "snippet-focus";
const PROJECT_ID = "project-1";

const h = vi.hoisted(() => ({
  editors: [] as unknown[],
  /** snippet_update が呼ばれた時点の editor 状態。 */
  saves: [] as {
    editable: boolean;
    active: string;
    text: string;
    content: string;
    baseVersion: number | undefined;
  }[],
  /** 設定すると snippet_update の応答を待たせる。 */
  holdUpdate: null as null | { release: () => void; promise: Promise<void> },
  /** DB 上の行（getSnippet が返す）。 */
  row: null as null | Record<string, unknown>,
  seq: 0,
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

vi.mock("@/features/revision/api", () => ({
  createRevision: vi.fn(() => Promise.resolve(null)),
  pruneRevisions: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/features/codex/tagApi", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/codex/tagApi")>();
  return { ...actual, listEntryTags: vi.fn(() => Promise.resolve([])) };
});

import { SnippetDetailContent } from "./SnippetDetailContent";
import { snippets } from "@/db/schema";
import type { Snippet } from "./api";
import { useSnippetStore } from "./snippetStore";
import { useProjectStore } from "@/features/project/projectStore";
import { useEditorSessionStore } from "@/features/editor/editorSessionStore";
import { publishCurrentProjectId } from "@/application/project/currentProjectAuthority";
import { setCurrentWorkspaceIdentity } from "@/runtime/workspaceIdentity";
import { discardAllAutoSaves } from "@/hooks/useAutoSave";
import { _resetTimelapseBodyWriteTailsForTests } from "@/features/timelapse/bodyWriteMode";
import {
  _inspectOwnSaveCapturesForTests,
  _resetRecorderForTests,
  initRecorderForProject,
  setRecorderEnabled,
} from "@/features/timelapse/recorder";

const SNIPPET = {
  id: SNIPPET_ID,
  projectId: PROJECT_ID,
  title: "Focus",
  content: "<p>start</p>",
  tagsCache: null,
  contentSource: null,
  sceneId: null,
  sourceChatMessageId: null,
  usageCount: 0,
  version: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
} as Snippet;

const IDENTITY = {
  projectId: PROJECT_ID,
  domain: "snippet",
  entityType: "snippet",
  entityId: SNIPPET_ID,
} as const;
const KEY = { kind: "snippet", id: SNIPPET_ID } as const;

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

/** schema の列順で DB 行を作る（db client は Object.values で位置対応させる）。 */
function dbRow(source: Record<string, unknown>): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const [key, column] of Object.entries(getTableColumns(snippets))) {
    row[column.name] = key in source ? source[key] : null;
  }
  return row;
}

function installBridge() {
  (window as unknown as { grimodex: unknown }).grimodex = {
    shell: "electron",
    invoke: async (
      cmd: string,
      args?: {
        sql?: string;
        payload?: { content?: string; baseVersion?: number };
        events?: Array<{ domain: string; opType: string }>;
      },
    ) => {
      if (cmd === "db_execute") {
        const sql = args?.sql ?? "";
        if (/from "snippets"/.test(sql) && h.row) {
          return { ok: true, value: { rows: [dbRow(h.row)] } };
        }
        return { ok: true, value: { rows: [] } };
      }
      if (cmd === "timelapse_append_batch") {
        for (const _event of args?.events ?? []) h.seq += 1;
        return { ok: true, value: { tailSequence: h.seq } };
      }
      if (cmd === "snippet_update") {
        const ed = h.editors.at(-1) as TiptapEditor | undefined;
        const content = args?.payload?.content ?? "";
        h.saves.push({
          editable: ed?.isEditable ?? true,
          active: describeActive(),
          text: ed?.state.doc.textContent ?? "",
          content,
          baseVersion: args?.payload?.baseVersion,
        });
        if (h.holdUpdate) await h.holdUpdate.promise;
        const version = Number(args?.payload?.baseVersion ?? 0) + 1;
        h.row = { ...h.row, content, version };
        return {
          ok: true,
          value: {
            entityId: SNIPPET_ID,
            version,
            changeEventUid: "snippet-change-event",
            maintenanceTransactionId: "snippet-maintenance-tx",
            undoJournalId: "snippet-undo-journal",
          },
        };
      }
      return { ok: true, value: null };
    },
  };
}

async function mountDetail(): Promise<{
  editor: TiptapEditor;
  pm: HTMLElement;
}> {
  const view = render(
    <SnippetDetailContent
      snippet={SNIPPET}
      onSave={(id, data, options) =>
        useSnippetStore.getState().update(id, data, options)
      }
      onDelete={() => {}}
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
  h.saves.length = 0;
  h.holdUpdate = null;
  h.seq = 0;
  h.row = { ...SNIPPET };

  publishCurrentProjectId(PROJECT_ID);
  setCurrentWorkspaceIdentity({ path: "/focus.gdx", openRevision: 1 });
  useEditorSessionStore.getState().resetForProject();
  useProjectStore.setState({ currentProjectId: PROJECT_ID });
  useSnippetStore.setState({ entries: [SNIPPET] });
});

afterEach(async () => {
  discardAllAutoSaves();
  cleanup();
  await nextFrame();
  _resetTimelapseBodyWriteTailsForTests();
  _resetRecorderForTests();
  delete (window as unknown as { grimodex?: unknown }).grimodex;
  publishCurrentProjectId(null);
  setCurrentWorkspaceIdentity(null);
});

const isDirty = () => useEditorSessionStore.getState().isDocumentDirty(KEY);

describe("断片本文の autosave と editor focus（実 Chromium）", () => {
  it("保存の間も editor は writable のまま focus が残り、保存中に打った文字は本文に入って追従保存で保存される", async () => {
    installBridge();
    setRecorderEnabled(true);
    await initRecorderForProject(PROJECT_ID);
    let release!: () => void;
    h.holdUpdate = {
      release: () => release(),
      promise: new Promise<void>((r) => (release = r)),
    };
    const { editor, pm } = await mountDetail();
    editor.commands.focus("end");
    await nextFrame();
    expect(document.activeElement).toBe(pm);
    await userEvent.keyboard("AB");

    // 本文 autosave は 2 秒の debounce の後に native へ届き、応答を待っている。
    await waitFor(() => expect(h.saves).toHaveLength(1), { timeout: 8_000 });
    expect(h.saves[0]).toMatchObject({ editable: true });
    expect(h.saves[0]!.active).toMatch(/\.ProseMirror$/);
    expect(h.saves[0]!.content).toContain("startAB");
    expect(editor.isEditable).toBe(true);
    expect(document.activeElement).toBe(pm);

    // 応答待ちの窓に打つ。文字は本文に入り、step は hold に預かられて queue へ直行しない。
    await userEvent.keyboard("XY");
    expect(editor.state.doc.textContent).toBe("startABXY");
    expect(document.activeElement).toBe(pm);
    const inWindow = _inspectOwnSaveCapturesForTests(IDENTITY);
    expect(inWindow.activeCaptures).toBe(1);
    expect(inWindow.heldCount).toBeGreaterThan(0);
    expect(inWindow.queueLength).toBe(0);
    expect(isDirty()).toBe(true);

    h.holdUpdate.release();
    h.holdUpdate = null;
    await nextFrame();
    await nextFrame();
    // 1 回目が完了しても、窓内の入力があるので dirty のまま。focus も残る。
    expect(isDirty()).toBe(true);
    expect(editor.isEditable).toBe(true);
    expect(document.activeElement).toBe(pm);
    expect(editor.state.doc.textContent).toBe("startABXY");

    // 追従保存（debounce の後）で窓内の入力が保存され、dirty が解ける。
    await waitFor(() => expect(h.saves).toHaveLength(2), { timeout: 8_000 });
    expect(h.saves[0]!.content).not.toContain("XY");
    expect(h.saves[1]!.content).toContain("startABXY");
    expect(h.saves[0]!.baseVersion).toBe(0);
    expect(h.saves[1]!.baseVersion).toBe(1);
    await waitFor(() => expect(isDirty()).toBe(false), { timeout: 5_000 });
    expect(_inspectOwnSaveCapturesForTests(IDENTITY).activeCaptures).toBe(0);

    // 保存が済んだ後も続きの打鍵が入る。
    await userEvent.keyboard("Z");
    expect(editor.state.doc.textContent).toBe("startABXYZ");
  }, 40_000);
});
