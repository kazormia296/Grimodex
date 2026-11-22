/**
 * Codex 本文（CodexDetailContent）の autosave でも editor が read-only にならない（EAR-12、T-11 (d)）。
 *
 * 以前は codex の本文保存が replacement fence（`runTimelapseBodyWrite`）を取り、保存の間
 * editor が read-only になって focus が落ち、保存中に打った文字が失われた。いまは
 * `persistTextPatch` が content の捕捉と同じ同期区間で capture hold を開き、api
 * （`updateCodexEntry`）が `runTimelapseEditorBodyWrite` で引き取る。
 *
 * 実 Chromium の実キー入力で、(1) 保存の間も editor は writable のまま focus が残り、
 * (2) 保存中に打った文字が本文に入って dirty が残り追従保存で保存され、
 * (3) その間の doc.step が hold に入ること（recorder を bind）を確かめる。
 * `updateCodexEntry` に isElectron の分岐はなく、web でも同じ経路を通る（fence から
 * hold への変更は web にも及ぶ）。IO 境界（native の IPC と DB 読み）だけが fake。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import type { Editor as TiptapEditor } from "@tiptap/core";
import { getTableColumns } from "drizzle-orm";

const ENTRY_ID = "codex-focus";
const PROJECT_ID = "project-1";

const h = vi.hoisted(() => ({
  editors: [] as unknown[],
  /** codex_update が呼ばれた時点の editor 状態。 */
  saves: [] as {
    editable: boolean;
    active: string;
    text: string;
    content: string;
    baseVersion: number | undefined;
  }[],
  /** 設定すると codex_update の応答を待たせる。 */
  holdUpdate: null as null | { release: () => void; promise: Promise<void> },
  /** DB 上の行（getCodexEntry が返す）。 */
  row: null as null | Record<string, unknown>,
  seq: 0,
  events: [] as { sequence: number; domain: string; opType: string }[],
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

vi.mock("../codexYomi", () => ({
  inferReadings: vi.fn(() => Promise.resolve(new Map())),
}));
vi.mock("../tagApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tagApi")>();
  return { ...actual, listEntryTags: vi.fn(() => Promise.resolve([])) };
});
vi.mock("@/features/revision/api", () => ({
  createRevision: vi.fn(() => Promise.resolve(null)),
  pruneRevisions: vi.fn(() => Promise.resolve()),
}));

// 本文以外の子（本試験の対象でない）。DetailsTab は実 CodexContentEditor を、
// 製品の DetailsTab と同じ props で包む。
vi.mock("./CodexEntryHeader", () => ({ CodexEntryHeader: () => null }));
vi.mock("./DetailTabs", () => ({ DetailTabs: () => null }));
vi.mock("./CodexEditLockBanner", () => ({ CodexEditLockBanner: () => null }));
vi.mock("@/features/editor/ExternalEditConflictBanner", () => ({
  ExternalEditConflictBanner: () => null,
}));
vi.mock("./DetailsTab", async () => {
  const { CodexContentEditor } = await import("./CodexContentEditor");
  return {
    DetailsTab: (props: {
      entry: { id: string; projectId: string; content: string | null };
      onContentChange: (content: string, doc?: unknown) => void;
      onExternalSync: (content: string) => void;
      readOnly: boolean;
    }) => (
      <CodexContentEditor
        content={props.entry.content ?? ""}
        onContentChange={props.onContentChange as never}
        onExternalSync={props.onExternalSync}
        entryId={props.entry.id}
        projectId={props.entry.projectId}
        readOnly={props.readOnly}
      />
    ),
  };
});

import { CodexDetailContent } from "./CodexDetailContent";
import { codexEntries } from "@/db/schema";
import type { CodexEntry } from "../api";
import { useCodexStore } from "../codexStore";
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

const doc = (text: string) =>
  JSON.stringify({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  });

const ENTRY: CodexEntry = {
  id: ENTRY_ID,
  projectId: PROJECT_ID,
  type: "character",
  name: "Focus",
  summary: "",
  content: doc("start"),
  icon: null,
  aliases: "[]",
  excludedAliases: "[]",
  readings: null,
  tagsCache: null,
  contextMode: "mentioned",
  childrenBudget: "compact",
  sourceChatMessageId: null,
  notes: null,
  parentId: null,
  version: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
} as CodexEntry;

const IDENTITY = {
  projectId: PROJECT_ID,
  domain: "codex",
  entityType: "codex_entry",
  entityId: ENTRY_ID,
} as const;
const KEY = { kind: "codex", id: ENTRY_ID, phaseId: null } as const;

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

/** schema の列順で DB 行を作る（db client は Object.values で位置対応させる）。 */
function dbRow(source: Record<string, unknown>): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const [key, column] of Object.entries(getTableColumns(codexEntries))) {
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
        if (/from "codex_entries"/.test(sql) && h.row) {
          return { ok: true, value: { rows: [dbRow(h.row)] } };
        }
        return { ok: true, value: { rows: [] } };
      }
      if (cmd === "timelapse_append_batch") {
        for (const event of args?.events ?? []) {
          h.seq += 1;
          h.events.push({
            sequence: h.seq,
            domain: event.domain,
            opType: event.opType,
          });
        }
        return { ok: true, value: { tailSequence: h.seq } };
      }
      if (cmd === "codex_update") {
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
            entityId: ENTRY_ID,
            version,
            changeEventUid: "codex-change-event",
            maintenanceTransactionId: "codex-maintenance-tx",
            undoJournalId: "codex-undo-journal",
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
  const view = render(<CodexDetailContent entry={ENTRY} onDelete={() => {}} />);
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
  h.events.length = 0;
  h.row = { ...ENTRY };

  publishCurrentProjectId(PROJECT_ID);
  setCurrentWorkspaceIdentity({ path: "/focus.gdx", openRevision: 1 });
  useEditorSessionStore.getState().resetForProject();
  useProjectStore.setState({ currentProjectId: PROJECT_ID });
  useCodexStore.setState({ entries: [ENTRY], selectedEntry: ENTRY });
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

describe("Codex 本文の autosave と editor focus（実 Chromium）", () => {
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
    await sleep(0);
  }, 40_000);
});
