/**
 * EditorPane の Codex／断片タブの autosave でも editor が read-only にならない（EAR-24）。
 *
 * タブで開いた Codex 本文・断片は EditorPane の `saveEditorDocument` を通る。以前は
 * この分岐が自分の保存の hold を開かず、store／api が replacement fence
 * （`runTimelapseBodyWrite`）に倒れて、保存の間 editor が read-only になり focus が
 * body に落ちて、保存中に打った文字が失われた。いまは本文の捕捉と同じ同期区間で hold を
 * 開いて渡す（CodexDetailContent／SnippetDetailContent と同じ方法）。
 *
 * 実 Chromium の実キー入力で、保存の間も editor が writable のまま focus が残り、
 * 保存中に打った文字が本文に入って dirty が残り、追従保存で保存されること、その窓内の
 * doc.step が hold に預かられること（recorder を bind）を確かめる。IO 境界（native の IPC と
 * DB 読み、文書の読み込み）だけが fake。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import type { Editor as TiptapEditor } from "@tiptap/core";
import { getTableColumns } from "drizzle-orm";

const ENTRY_ID = "entry-focus";
const PROJECT_ID = "project-1";

type Kind = "codex" | "snippet";

const h = vi.hoisted(() => ({
  editors: [] as unknown[],
  kind: "codex" as "codex" | "snippet",
  /** codex_update／snippet_update が呼ばれた時点の editor 状態。 */
  saves: [] as {
    editable: boolean;
    active: string;
    content: string;
    baseVersion: number | undefined;
  }[],
  holdUpdate: null as null | { release: () => void; promise: Promise<void> },
  row: null as null | Record<string, unknown>,
  seq: 0,
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

vi.mock("@/features/editor/document/loadEditorDocument", async () => {
  const actual = await vi.importActual<
    typeof import("@/features/editor/document/loadEditorDocument")
  >("@/features/editor/document/loadEditorDocument");
  return {
    ...actual,
    loadEditorDocument: vi.fn(async () =>
      h.kind === "codex"
        ? {
            binding: {
              kind: "codex",
              id: ENTRY_ID,
              phaseId: null,
              loadedVersion: 0,
            },
            content: {
              type: "doc",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "start" }],
                },
              ],
            },
            projectId: PROJECT_ID,
          }
        : {
            binding: { kind: "snippet", id: ENTRY_ID, loadedVersion: 0 },
            content: "<p>start</p>",
            projectId: PROJECT_ID,
          },
    ),
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
import { codexEntries, snippets } from "@/db/schema";
import type { CodexEntry } from "@/features/codex/api";
import type { Snippet } from "@/features/snippets/api";
import { useCodexStore } from "@/features/codex/codexStore";
import { useSnippetStore } from "@/features/snippets/snippetStore";
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
  initRecorderForProject,
  setRecorderEnabled,
} from "@/features/timelapse/recorder";

const CODEX_ENTRY = {
  id: ENTRY_ID,
  projectId: PROJECT_ID,
  type: "character",
  name: "Focus",
  summary: "",
  content: JSON.stringify({
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "start" }] },
    ],
  }),
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

const SNIPPET = {
  id: ENTRY_ID,
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

function dbRow(
  table: typeof codexEntries | typeof snippets,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const [key, column] of Object.entries(getTableColumns(table))) {
    row[column.name] = key in source ? source[key] : null;
  }
  return row;
}

function installBridge(kind: Kind) {
  const command = kind === "codex" ? "codex_update" : "snippet_update";
  const tableName = kind === "codex" ? "codex_entries" : "snippets";
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
        if (new RegExp(`from "${tableName}"`).test(sql) && h.row) {
          return {
            ok: true,
            value: {
              rows: [dbRow(kind === "codex" ? codexEntries : snippets, h.row)],
            },
          };
        }
        return { ok: true, value: { rows: [] } };
      }
      if (cmd === "timelapse_append_batch") {
        for (const _event of args?.events ?? []) h.seq += 1;
        return { ok: true, value: { tailSequence: h.seq } };
      }
      if (cmd === command) {
        const content = args?.payload?.content ?? "";
        h.saves.push({
          editable: latestEditor().isEditable,
          active: describeActive(),
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
            changeEventUid: `${kind}-change-event`,
            maintenanceTransactionId: `${kind}-maintenance-tx`,
            undoJournalId: `${kind}-undo-journal`,
          },
        };
      }
      return { ok: true, value: null };
    },
  };
}

async function mountPane(
  kind: Kind,
): Promise<{ editor: TiptapEditor; pm: HTMLElement }> {
  const view = render(
    <EditorPane
      nodeId={ENTRY_ID}
      contentType={kind}
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
  h.saves.length = 0;
  h.holdUpdate = null;
  h.seq = 0;
  publishCurrentProjectId(PROJECT_ID);
  setCurrentWorkspaceIdentity({ path: "/focus.gdx", openRevision: 1 });
  useEditorSessionStore.getState().resetForProject();
  useProjectStore.setState({ currentProjectId: PROJECT_ID });
  useCodexStore.setState({
    entries: [CODEX_ENTRY],
    selectedEntry: CODEX_ENTRY,
  });
  useSnippetStore.setState({ entries: [SNIPPET] });
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
});

describe.each<[string, Kind]>([
  ["Codex タブ", "codex"],
  ["断片タブ", "snippet"],
])(
  "EditorPane の %s の autosave と editor focus（実 Chromium）",
  (_name, kind) => {
    const key =
      kind === "codex"
        ? ({ kind: "codex", id: ENTRY_ID, phaseId: null } as const)
        : ({ kind: "snippet", id: ENTRY_ID } as const);
    const identity = {
      projectId: PROJECT_ID,
      domain: kind,
      entityType: kind === "codex" ? "codex_entry" : "snippet",
      entityId: ENTRY_ID,
    } as const;
    const isDirty = () => useEditorSessionStore.getState().isDocumentDirty(key);

    it("保存の間も editor は writable のまま focus が残り、保存中に打った文字は本文に入って追従保存で保存される（fence を取らない）", async () => {
      h.kind = kind;
      h.row = kind === "codex" ? { ...CODEX_ENTRY } : { ...SNIPPET };
      installBridge(kind);
      setRecorderEnabled(true);
      await initRecorderForProject(PROJECT_ID);
      let release!: () => void;
      h.holdUpdate = {
        release: () => release(),
        promise: new Promise<void>((r) => (release = r)),
      };
      const { editor, pm } = await mountPane(kind);
      editor.commands.focus("end");
      await nextFrame();
      expect(document.activeElement).toBe(pm);
      await userEvent.keyboard("AB");

      await waitFor(() => expect(h.saves).toHaveLength(1), { timeout: 8_000 });
      // fence を取ると、ここで editor は read-only になり focus が body に落ちる。
      expect(h.saves[0]).toMatchObject({ editable: true });
      expect(h.saves[0]!.active).toMatch(/\.ProseMirror$/);
      expect(h.saves[0]!.content).toContain("startAB");
      expect(editor.isEditable).toBe(true);
      expect(document.activeElement).toBe(pm);

      // 応答待ちの窓に打つ。文字は本文に入り、step は hold に預かられて queue へ直行しない。
      await userEvent.keyboard("XY");
      expect(editor.state.doc.textContent).toBe("startABXY");
      expect(document.activeElement).toBe(pm);
      const inWindow = _inspectOwnSaveCapturesForTests(identity);
      expect(inWindow.activeCaptures).toBe(1);
      expect(inWindow.heldCount).toBeGreaterThan(0);
      expect(inWindow.queueLength).toBe(0);
      expect(isDirty()).toBe(true);

      h.holdUpdate.release();
      h.holdUpdate = null;
      await nextFrame();
      await nextFrame();
      expect(isDirty()).toBe(true);
      expect(editor.isEditable).toBe(true);
      expect(document.activeElement).toBe(pm);
      expect(editor.state.doc.textContent).toBe("startABXY");

      await waitFor(() => expect(h.saves).toHaveLength(2), { timeout: 8_000 });
      expect(h.saves[0]!.content).not.toContain("XY");
      expect(h.saves[1]!.content).toContain("startABXY");
      expect(h.saves[0]!.baseVersion).toBe(0);
      expect(h.saves[1]!.baseVersion).toBe(1);
      await waitFor(() => expect(isDirty()).toBe(false), { timeout: 5_000 });
      expect(_inspectOwnSaveCapturesForTests(identity).activeCaptures).toBe(0);

      await userEvent.keyboard("Z");
      expect(editor.state.doc.textContent).toBe("startABXYZ");
    }, 40_000);
  },
);
