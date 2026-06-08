import { getSchema } from "@tiptap/core";
import { Node as ProseMirrorNode, type Schema } from "@tiptap/pm/model";
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import {
  treeNodes,
  codexEntries,
  codexDetailValues,
  codexDetailDefinitions,
  codexRelations,
} from "@/db/schema";
import { invoke } from "@/lib/tauri";
import { getEditorExtensions } from "@/features/editor/extensions";
import { flattenDocForCodex } from "@/features/editor/codexDocFlatten";
import { countSceneBodyCharsFromJson } from "@/features/editor/charCountForBody";
import { extractPlacedBeatPreviewFromString } from "@/features/editor/beat/placedBeatPreview";
import {
  agentWriteBundle,
  type BatchStatement,
} from "@/features/agent-writes/bundle";
import { useGlobalHistoryStore } from "@/store/globalHistoryStore";
import { useTabStore } from "@/features/editor/tabStore";
import { useTreeStore } from "@/features/tree/treeStore";
import { useSceneContentStore } from "@/features/editor/sceneContentStore";
import { saveScene } from "@/features/editor/editorSaveRegistry";
import { listNodes } from "@/features/tree/api";
import { listCodexEntries, type CodexEntry } from "../api";
import { listCodexRelations } from "../codexRelationApi";
import { useCodexStore } from "../codexStore";
import { enqueueRescan } from "../mentionRescanQueue";
import type { CodexMatchTarget } from "../codexMatcher";
import {
  detectRenameOccurrences,
  PM_DOC_KINDS,
  type DetectRenameResult,
  type RenameOccurrence,
  type RenameSourceText,
} from "./detectOccurrences";
import {
  applyReplacementsToDoc,
  applyReplacementsToString,
  type FlatSpan,
} from "./applyReplacementsToDoc";

/**
 * Rename propagation engine (Item C apply layer).
 *
 * `prepareRenamePropagation` gathers every free-text field in the project,
 * flushes open editors, and runs detection → the UI shows a modal preview.
 * `applyRenamePropagation` rewrites the user-selected occurrences in a single
 * atomic `agentWriteBundle` (one undo), then re-syncs open editors / stores and
 * re-runs the body-mention scan.
 *
 * Architecture: uniform (NOT hybrid). A DB write does not refresh the live
 * editor (the `sceneContentStore` channel is separate from `saveSceneContent`),
 * and the single-undo requirement rules out mixing native editor transactions
 * with the DB batch. See docs/Grimodex_Codex改名波及設計書.md §5.3.
 *
 * I/O orchestration — must be verified in-app (`pnpm tauri dev`); the pure cores
 * (detect / flatten / replace) are unit-tested separately.
 */

// Sentinel source-group for setLiveContent: out of band of every real editor
// group (panes use 0/1), so no open editor filters our resync out as "its own".
const RESYNC_GROUP = -1;

let cachedSchema: Schema | null = null;
function getDocSchema(): Schema {
  if (!cachedSchema) {
    // The mention stub is load-bearing: without it the schema omits the mention
    // node and `Node.fromJSON` throws on any doc containing an @mention.
    cachedSchema = getSchema(
      getEditorExtensions({ setMentionPopup: () => {} }),
    );
  }
  return cachedSchema;
}

/** ProseMirror content can be stored as a JSON string or an already-parsed object. */
function toJsonString(raw: unknown): string | null {
  if (raw == null) return null;
  const s = typeof raw === "string" ? raw : JSON.stringify(raw);
  const t = s.trim();
  if (t === "" || t === "{}" || t === "[]") return null;
  if (!t.startsWith("{")) return null;
  return s;
}

interface Flat {
  text: string;
  isRubyByOffset: boolean[];
}

function flattenJson(
  jsonStr: string,
  schema: Schema,
  context: string,
): Flat | null {
  try {
    const doc = ProseMirrorNode.fromJSON(schema, JSON.parse(jsonStr));
    const { text, flatIsRuby } = flattenDocForCodex(doc);
    return { text, isRubyByOffset: flatIsRuby };
  } catch (e) {
    // Never swallow silently: a skipped source would make the preview undercount
    // ("N件" reported with a scene missing) with no signal. The schema is the
    // editor's own (getEditorExtensions), so this should only fire on corrupt
    // JSON or future schema drift — but make it observable when it does.
    console.warn(`[codexRename] skipped flatten for ${context}:`, e);
    return null;
  }
}

/** Load every free-text field in the project into matcher-ready sources. */
export async function gatherRenameSources(
  projectId: string,
): Promise<RenameSourceText[]> {
  const schema = getDocSchema();
  const sources: RenameSourceText[] = [];

  // --- tree nodes: title (plain), synopsis (plain), scene body (PM doc) ---
  const nodes = await listNodes(projectId);
  for (const n of nodes) {
    const label = n.title || n.id;
    if (n.title) {
      sources.push({
        kind: "node-title",
        refId: n.id,
        refLabel: label,
        text: n.title,
      });
    }
    if (n.synopsis) {
      sources.push({
        kind: "node-synopsis",
        refId: n.id,
        refLabel: label,
        text: n.synopsis,
      });
    }
    if (n.nodeType === "scene") {
      const json = toJsonString(n.content);
      const flat = json ? flattenJson(json, schema, `scene ${n.id}`) : null;
      if (flat && json) {
        sources.push({
          kind: "scene-body",
          refId: n.id,
          refLabel: label,
          text: flat.text,
          isRubyByOffset: flat.isRubyByOffset,
          rawContent: json,
        });
      }
    }
  }

  // --- codex entries: summary (plain), content & notes (PM docs) ---
  const entries = await listCodexEntries(projectId);
  for (const e of entries as CodexEntry[]) {
    if (e.summary) {
      sources.push({
        kind: "codex-summary",
        refId: e.id,
        refLabel: e.name,
        text: e.summary,
      });
    }
    for (const [kind, raw] of [
      ["codex-content", e.content],
      ["codex-notes", e.notes],
    ] as const) {
      const json = toJsonString(raw);
      const flat = json ? flattenJson(json, schema, `${kind} ${e.id}`) : null;
      if (flat && json) {
        sources.push({
          kind,
          refId: e.id,
          refLabel: e.name,
          text: flat.text,
          isRubyByOffset: flat.isRubyByOffset,
          rawContent: json,
        });
      }
    }
  }

  // --- codex detail values (fieldType=text only) ---
  const detailRows = await db
    .select({
      entryId: codexDetailValues.entryId,
      definitionId: codexDetailValues.definitionId,
      value: codexDetailValues.value,
      fieldType: codexDetailDefinitions.fieldType,
      fieldName: codexDetailDefinitions.name,
    })
    .from(codexDetailValues)
    .innerJoin(
      codexDetailDefinitions,
      eq(codexDetailValues.definitionId, codexDetailDefinitions.id),
    )
    .where(eq(codexDetailDefinitions.projectId, projectId));
  for (const r of detailRows) {
    if (r.fieldType !== "text" || !r.value) continue;
    sources.push({
      kind: "codex-detail",
      refId: r.entryId,
      refLabel: r.fieldName,
      detailDefinitionId: r.definitionId,
      text: r.value,
    });
  }

  // --- codex relation labels (plain) ---
  const relations = await listCodexRelations(projectId);
  for (const r of relations) {
    if (r.label) {
      sources.push({
        kind: "codex-relation-label",
        refId: r.id,
        refLabel: r.label,
        text: r.label,
      });
    }
  }

  return sources;
}

/** Currently-open node ids (both editor groups). */
function openNodeIds(): Set<string> {
  const s = useTabStore.getState();
  return new Set([
    ...s.tabs.map((t) => t.nodeId),
    ...s.secondaryTabs.map((t) => t.nodeId),
  ]);
}

export interface PrepareRenameParams {
  projectId: string;
  entryId: string;
  oldName: string;
  newName: string;
}

/**
 * Flush open editors → gather all free-text → detect old-name occurrences.
 * Returns the result for the preview modal. No writes.
 */
export async function prepareRenamePropagation(
  params: PrepareRenameParams,
): Promise<DetectRenameResult> {
  const { projectId, entryId, oldName, newName } = params;
  if (!oldName || oldName === newName) {
    return { occurrences: [], ambiguous: false };
  }

  // Flush every open editor so the DB (which gather reads) reflects unsaved edits.
  await Promise.all(
    [...openNodeIds()].map((id) => saveScene(id).catch(() => {})),
  );

  const [sources, allTargets] = await Promise.all([
    gatherRenameSources(projectId),
    listCodexEntries(projectId).then((es) =>
      (es as CodexEntry[]).map(
        (e): CodexMatchTarget => ({
          id: e.id,
          name: e.name,
          type: e.type,
          aliases: e.aliases,
          excludedAliases: e.excludedAliases,
        }),
      ),
    ),
  ]);

  return detectRenameOccurrences({
    entryId,
    oldName,
    newName,
    allTargets,
    sources,
  });
}

function toStatement(q: { sql: string; params: unknown[] }): BatchStatement {
  return { sql: q.sql, params: q.params, method: "run" };
}

/** Build forward + undo UPDATE statements for one source's new/old value. */
function buildStatements(
  source: RenameSourceText,
  oldValue: string,
  newValue: string,
  projectId: string,
  now: string,
): { forward: BatchStatement[]; undo: BatchStatement[] } {
  const id = source.refId;
  const scoped = (
    idCol: typeof treeNodes.id,
    projCol: typeof treeNodes.projectId,
  ) => and(eq(idCol, id), eq(projCol, projectId));

  switch (source.kind) {
    case "scene-body": {
      const set = (content: string) => ({
        content,
        charCount: countSceneBodyCharsFromJson(content),
        placedBeatPreview: extractPlacedBeatPreviewFromString(content),
        updatedAt: now,
      });
      return {
        forward: [
          toStatement(
            db
              .update(treeNodes)
              .set(set(newValue))
              .where(scoped(treeNodes.id, treeNodes.projectId))
              .toSQL(),
          ),
        ],
        undo: [
          toStatement(
            db
              .update(treeNodes)
              .set(set(oldValue))
              .where(scoped(treeNodes.id, treeNodes.projectId))
              .toSQL(),
          ),
        ],
      };
    }
    case "node-title":
    case "node-synopsis": {
      const col = source.kind === "node-title" ? "title" : "synopsis";
      const mk = (v: string) =>
        toStatement(
          db
            .update(treeNodes)
            .set({ [col]: v, updatedAt: now })
            .where(scoped(treeNodes.id, treeNodes.projectId))
            .toSQL(),
        );
      return { forward: [mk(newValue)], undo: [mk(oldValue)] };
    }
    case "codex-summary":
    case "codex-content":
    case "codex-notes": {
      const col =
        source.kind === "codex-summary"
          ? "summary"
          : source.kind === "codex-content"
            ? "content"
            : "notes";
      const mk = (v: string) =>
        toStatement(
          db
            .update(codexEntries)
            .set({ [col]: v, updatedAt: now })
            .where(
              and(
                eq(codexEntries.id, id),
                eq(codexEntries.projectId, projectId),
              ),
            )
            .toSQL(),
        );
      return { forward: [mk(newValue)], undo: [mk(oldValue)] };
    }
    case "codex-detail": {
      const mk = (v: string) =>
        toStatement(
          db
            .update(codexDetailValues)
            .set({ value: v })
            .where(
              and(
                eq(codexDetailValues.entryId, id),
                eq(codexDetailValues.definitionId, source.detailDefinitionId!),
              ),
            )
            .toSQL(),
        );
      return { forward: [mk(newValue)], undo: [mk(oldValue)] };
    }
    case "codex-relation-label": {
      const mk = (v: string) =>
        toStatement(
          db
            .update(codexRelations)
            .set({ label: v })
            .where(
              and(
                eq(codexRelations.id, id),
                eq(codexRelations.projectId, projectId),
              ),
            )
            .toSQL(),
        );
      return { forward: [mk(newValue)], undo: [mk(oldValue)] };
    }
  }
}

export interface ApplyRenameParams {
  projectId: string;
  entryId: string;
  oldName: string;
  newName: string;
  /** User-confirmed occurrences (caller filters out ruby + unchecked rows). */
  selected: RenameOccurrence[];
}

/**
 * Rewrite the selected occurrences atomically and re-sync the UI. One undo.
 */
export async function applyRenamePropagation(
  params: ApplyRenameParams,
): Promise<{ applied: number }> {
  const { projectId, entryId, oldName, newName, selected } = params;
  if (!newName || selected.length === 0) return { applied: 0 };

  const schema = getDocSchema();

  // Group selected spans per source.
  const groups = new Map<
    string,
    { source: RenameSourceText; spans: FlatSpan[] }
  >();
  for (const occ of selected) {
    if (occ.ruby) continue; // ruby spans aren't rewritable
    const s = occ.source;
    const key = `${s.kind}:${s.refId}:${s.detailDefinitionId ?? ""}`;
    let g = groups.get(key);
    if (!g) {
      g = { source: s, spans: [] };
      groups.set(key, g);
    }
    g.spans.push({ from: occ.from, to: occ.to });
  }

  const now = new Date().toISOString();
  const forward: BatchStatement[] = [];
  const undo: BatchStatement[] = [];
  // Open scene/codex bodies → new & old JSON for live-editor resync per direction.
  const open = openNodeIds();
  const liveNew = new Map<string, object>();
  const liveOld = new Map<string, object>();
  let applied = 0;

  for (const { source, spans } of groups.values()) {
    let oldValue: string;
    let newValue: string;

    if (PM_DOC_KINDS.has(source.kind) && source.rawContent) {
      oldValue = source.rawContent;
      const doc = ProseMirrorNode.fromJSON(
        schema,
        JSON.parse(source.rawContent),
      );
      const res = applyReplacementsToDoc(doc, spans, newName);
      if (res.applied === 0) continue;
      const nextJson = res.doc.toJSON();
      newValue = JSON.stringify(nextJson);
      applied += res.applied;
      if (open.has(source.refId)) {
        liveNew.set(source.refId, nextJson);
        liveOld.set(source.refId, JSON.parse(oldValue));
      }
    } else {
      oldValue = source.text;
      newValue = applyReplacementsToString(source.text, spans, newName);
      if (newValue === oldValue) continue;
      applied += spans.length;
    }

    const { forward: f, undo: u } = buildStatements(
      source,
      oldValue,
      newValue,
      projectId,
      now,
    );
    forward.push(...f);
    undo.push(...u);
  }

  if (forward.length === 0) return { applied: 0 };

  const resync = async (live: Map<string, object>) => {
    try {
      await useTreeStore.getState().reloadTreeOrThrow(projectId);
    } catch (e) {
      console.error("[codexRename] tree reload failed (change committed)", e);
    }
    try {
      await useCodexStore.getState().loadEntries();
    } catch (e) {
      console.error("[codexRename] codex reload failed (change committed)", e);
    }
    const setLive = useSceneContentStore.getState().setLiveContent;
    for (const [id, content] of live) setLive(id, content, RESYNC_GROUP);
    // Re-establish body-mention rows/highlights stripped by the rename commit's
    // own enqueueRescan (which ran with the NEW name before the prose existed).
    enqueueRescan(entryId);
  };

  const eventUid = crypto.randomUUID();
  const summary = JSON.stringify({ entryId, oldName, newName, applied });

  const runForward = async () => {
    await agentWriteBundle({
      projectId,
      surface: "codex-rename-propagation",
      statements: forward,
      undoJournal: {
        entityKind: "codex_rename",
        entityId: entryId,
        opKind: "codex.renamePropagate",
        beforeJson: null,
        afterJson: summary,
        baseVersion: 0,
        resultVersion: 1,
      },
      changeEvent: {
        eventUid,
        sceneId: null,
        domain: "codex",
        opType: "codex.renamePropagate",
        entityType: "codex_entry",
        entityId: entryId,
        payload: summary,
        timestamp: Date.now(),
      },
    });
    await resync(liveNew);
  };

  const runUndo = async () => {
    await invoke("db_execute_batch", { statements: undo });
    await resync(liveOld);
  };

  await runForward();

  if (!useGlobalHistoryStore.getState().isReplaying) {
    useGlobalHistoryStore.getState().push({
      kind: "scenes",
      label: `「${oldName}」→「${newName}」の本文反映`,
      entityId: entryId,
      undo: runUndo,
      redo: runForward,
    });
  }

  return { applied };
}
