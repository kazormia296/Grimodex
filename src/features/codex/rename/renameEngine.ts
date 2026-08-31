import { getSchema } from "@tiptap/core";
import i18next from "@/lib/i18n";
import { Node as ProseMirrorNode, type Schema } from "@tiptap/pm/model";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { codexDetailValues, codexDetailDefinitions } from "@/db/schema";
import { invoke } from "@/lib/tauri";
import { getEditorExtensions } from "@/features/editor/extensions";
import { flattenDocForCodex } from "@/features/editor/codexDocFlatten";
import { countSceneBodyCharsFromJson } from "@/features/editor/charCountForBody";
import { extractPlacedBeatPreviewFromString } from "@/features/editor/beat/placedBeatPreview";
import { useGlobalHistoryStore } from "@/store/globalHistoryStore";
import { useTreeStore } from "@/features/tree/treeStore";
import {
  useSceneContentStore,
  hasLiveContentSubscriber,
} from "@/features/editor/sceneContentStore";
import {
  saveScene,
  registeredSaveHandlerIds,
} from "@/features/editor/editorSaveRegistry";
import { listNodes, loadSceneContents } from "@/features/tree/api";
import {
  listCodexEntries,
  listCodexMatchTargets,
  type CodexEntry,
} from "../api";
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
import {
  encodeDocumentKey,
  type DocumentKey,
} from "@/features/editor/document/documentKey";
import { getRecorderSessionId } from "@/features/timelapse/recorder";
import { runTimelapseBodyReplacement } from "@/features/timelapse/bodyWriteMode";

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
 * I/O orchestration — must be verified in-app (`pnpm electron:dev`); the pure cores
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
  // listNodes は content を返さない軽量 projection (H4)。scene 本文は
  // content 専用バッチで 1 往復にまとめてロードする (per-scene N+1 回避)。
  const sceneContents = await loadSceneContents(
    nodes.filter((n) => n.nodeType === "scene").map((n) => n.id),
  );
  for (const n of nodes) {
    const label = n.title || n.id;
    if (n.title) {
      sources.push({
        kind: "node-title",
        refId: n.id,
        baseVersion: n.version,
        refLabel: label,
        text: n.title,
      });
    }
    if (n.synopsis) {
      sources.push({
        kind: "node-synopsis",
        refId: n.id,
        baseVersion: n.version,
        refLabel: label,
        text: n.synopsis,
      });
    }
    if (n.nodeType === "scene") {
      const json = toJsonString(sceneContents.get(n.id));
      const flat = json ? flattenJson(json, schema, `scene ${n.id}`) : null;
      if (flat && json) {
        sources.push({
          kind: "scene-body",
          refId: n.id,
          baseVersion: n.version,
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
        baseVersion: e.version,
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
          baseVersion: e.version,
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
      version: codexDetailValues.version,
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
      baseVersion: r.version,
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
        baseVersion: r.version,
        refLabel: r.label,
        text: r.label,
      });
    }
  }

  return sources;
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

  // Flush every live editor so the DB (which gather reads) reflects unsaved
  // edits. The save registry covers tab panes AND linear-mode blocks — a tab
  // list would miss linear editors, whose stale DB body would then be renamed
  // and written back over the user's latest typing.
  await Promise.all(
    registeredSaveHandlerIds().map((id) => saveScene(id).catch(() => {})),
  );

  const [sources, allTargets] = await Promise.all([
    gatherRenameSources(projectId),
    // match target 用途なので軽量 projection。CodexMatchRow は
    // CodexMatchTarget と構造互換 (aliases: string | null ⊂ 許容型)。
    listCodexMatchTargets(projectId) satisfies Promise<CodexMatchTarget[]>,
  ]);

  return detectRenameOccurrences({
    entryId,
    oldName,
    newName,
    allTargets,
    sources,
  });
}

interface RenameUndoUpdate {
  kind: RenameSourceText["kind"];
  refId: string;
  detailDefinitionId: string | null;
  baseVersion: number;
  value: string;
  charCount: number | null;
  placedBeatPreview: string | null;
}

function buildRenameUndoUpdate(
  source: RenameSourceText,
  oldValue: string,
): RenameUndoUpdate {
  return {
    kind: source.kind,
    refId: source.refId,
    detailDefinitionId: source.detailDefinitionId ?? null,
    baseVersion: source.baseVersion,
    value: oldValue,
    charCount:
      source.kind === "scene-body"
        ? countSceneBodyCharsFromJson(oldValue)
        : null,
    placedBeatPreview:
      source.kind === "scene-body"
        ? extractPlacedBeatPreviewFromString(oldValue)
        : null,
  };
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
  const forward: RenameUndoUpdate[] = [];
  const undoUpdates: RenameUndoUpdate[] = [];
  // Live scene/codex bodies → new & old JSON for live-editor resync per
  // direction. Subscriber check, NOT a tab-list check: linear-mode editors
  // have no tab but must still be resynced or their next autosave clobbers
  // the propagated rename.
  const liveNew = new Map<string, { key: DocumentKey; content: object }>();
  const liveOld = new Map<string, { key: DocumentKey; content: object }>();
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
      const documentKey: DocumentKey | null =
        source.kind === "scene-body"
          ? { kind: "tree", id: source.refId, storage: "database" }
          : source.kind === "codex-content"
            ? { kind: "codex", id: source.refId, phaseId: null }
            : null;
      if (documentKey && hasLiveContentSubscriber(documentKey)) {
        const encoded = encodeDocumentKey(documentKey);
        liveNew.set(encoded, { key: documentKey, content: nextJson });
        liveOld.set(encoded, {
          key: documentKey,
          content: JSON.parse(oldValue) as object,
        });
      }
    } else {
      oldValue = source.text;
      newValue = applyReplacementsToString(source.text, spans, newName);
      if (newValue === oldValue) continue;
      applied += spans.length;
    }

    forward.push(buildRenameUndoUpdate(source, newValue));
    undoUpdates.push(buildRenameUndoUpdate(source, oldValue));
  }

  if (forward.length === 0) return { applied: 0 };

  const resync = async (
    live: Map<string, { key: DocumentKey; content: object }>,
  ) => {
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
    for (const { key, content } of live.values()) {
      setLive(key, content, RESYNC_GROUP);
    }
    // Re-establish body-mention rows/highlights stripped by the rename commit's
    // own enqueueRescan (which ran with the NEW name before the prose existed).
    void enqueueRescan(entryId);
  };

  const summary = JSON.stringify({ entryId, oldName, newName, applied });
  let originalMaintenanceTransactionId: string | null = null;
  let originalUndoJournalId: string | null = null;

  const renameAggregateKey = (update: RenameUndoUpdate): string =>
    update.kind === "codex-detail"
      ? `codex-detail:${update.refId}:${update.detailDefinitionId ?? ""}`
      : update.kind.startsWith("codex-")
        ? `codex-entry:${update.refId}`
        : `tree-node:${update.refId}`;

  // Native increments exactly one OCC version per selected source.  Keep the
  // inverse side at the version produced by the successful transaction so an
  // undo/redo remains CAS-protected without rereading a partially changed set.
  const advanceInverseVersions = (
    appliedUpdates: RenameUndoUpdate[],
    inverseUpdates: RenameUndoUpdate[],
  ) => {
    const finalVersions = new Map<string, number>();
    const counts = new Map<string, number>();
    for (let index = 0; index < appliedUpdates.length; index += 1) {
      const appliedUpdate = appliedUpdates[index];
      if (!appliedUpdate) continue;
      const key = renameAggregateKey(appliedUpdate);
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      finalVersions.set(key, appliedUpdate.baseVersion + count);
    }
    for (const inverseUpdate of inverseUpdates) {
      const version = finalVersions.get(renameAggregateKey(inverseUpdate));
      if (version !== undefined) inverseUpdate.baseVersion = version;
    }
  };

  const setInverseVersions = (
    appliedUpdates: RenameUndoUpdate[],
    inverseUpdates: RenameUndoUpdate[],
    result: unknown,
  ) => {
    const versions =
      result && typeof result === "object" && "versions" in result
        ? (result as { versions?: unknown }).versions
        : undefined;
    if (
      Array.isArray(versions) &&
      versions.length === inverseUpdates.length &&
      versions.every(
        (item) =>
          item !== null &&
          typeof item === "object" &&
          typeof (item as { version?: unknown }).version === "number" &&
          Number.isSafeInteger((item as { version: number }).version),
      )
    ) {
      const finalVersions = new Map<string, number>();
      for (let index = 0; index < inverseUpdates.length; index += 1) {
        const appliedUpdate = appliedUpdates[index];
        if (!appliedUpdate) continue;
        finalVersions.set(
          renameAggregateKey(appliedUpdate),
          (versions[index] as { version: number }).version,
        );
      }
      for (const inverseUpdate of inverseUpdates) {
        const version = finalVersions.get(renameAggregateKey(inverseUpdate));
        if (version !== undefined) inverseUpdate.baseVersion = version;
      }
      return;
    }
    advanceInverseVersions(appliedUpdates, inverseUpdates);
  };

  const runForward = () =>
    runTimelapseBodyReplacement(
      { projectId },
      {
        commit: async () => {
          const requestId = crypto.randomUUID();
          const redo = originalMaintenanceTransactionId !== null;
          const result = await invoke("codex_rename_apply", {
            payload: {
              requestId,
              projectId,
              sessionId: getRecorderSessionId(),
              surface: "codex-rename-propagation",
              entryId,
              updatedAt: now,
              updates: forward,
              eventSummary: summary,
              eventUid: requestId,
              timestamp: Date.now(),
              redo,
              originalTransactionId: redo
                ? originalMaintenanceTransactionId
                : null,
              undoJournalId: redo ? originalUndoJournalId : null,
            },
          });
          if (!redo && result && typeof result === "object") {
            const maintenanceTransactionId = (
              result as { maintenanceTransactionId?: unknown }
            ).maintenanceTransactionId;
            const undoJournalId = (result as { undoJournalId?: unknown })
              .undoJournalId;
            if (
              typeof maintenanceTransactionId !== "string" ||
              maintenanceTransactionId.length === 0 ||
              typeof undoJournalId !== "string" ||
              undoJournalId.length === 0
            ) {
              throw new Error("Codex rename Native receipt is incomplete");
            }
            originalMaintenanceTransactionId = maintenanceTransactionId;
            originalUndoJournalId = undoJournalId;
          }
          setInverseVersions(forward, undoUpdates, result);
          return result;
        },
        project: async () => {
          await resync(liveNew);
        },
      },
    );

  const runUndo = () =>
    runTimelapseBodyReplacement(
      { projectId },
      {
        commit: async () => {
          if (!originalMaintenanceTransactionId || !originalUndoJournalId) {
            throw new Error("Codex rename Native lineage is unavailable");
          }
          const requestId = crypto.randomUUID();
          const result = await invoke("codex_rename_undo", {
            payload: {
              requestId,
              eventUid: requestId,
              originalTransactionId: originalMaintenanceTransactionId,
              undoJournalId: originalUndoJournalId,
              projectId,
              sessionId: getRecorderSessionId(),
              updatedAt: now,
              updates: undoUpdates,
            },
          });
          setInverseVersions(undoUpdates, forward, result);
          return result;
        },
        project: async () => {
          await resync(liveOld);
        },
      },
    );

  await runForward();

  if (!useGlobalHistoryStore.getState().isReplaying) {
    useGlobalHistoryStore.getState().push({
      kind: "scenes",
      label: i18next.t("codex.history.renamePropagated", {
        oldName,
        newName,
      }),
      entityId: entryId,
      undo: runUndo,
      redo: runForward,
    });
  }

  return { applied };
}
