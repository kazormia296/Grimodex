import { db } from "@/db/client";
import { codexEntries } from "@/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { invoke } from "@/lib/tauri";
import { enqueueRescan } from "./mentionRescanQueue";
import { scheduleCodexIndex } from "@/features/semantic-search/scheduler";
import { CodexVersionConflictError } from "./occ";
import { scheduleImeExportRefresh } from "@/features/ime/scheduler";
import { markImpactBaselinePhasesRestricted } from "./impactBaselineVisibility";
import type { CodexEntryType } from "./codexMatchTargets";
import { chatPersistenceDeletionGuard } from "@/lib/chatPersistenceDeletionGuard";
import {
  ChatAnchorDeletionBlockedError,
  tryAcquireChatAnchorDeletionLease,
} from "@/lib/chatNavigationGuard";
import { notifyCodexAnchorDeletedIfRegistered } from "@/application/codex/codexAnchorLifecycle";
import { normalizeForeshadowRow } from "@/features/foreshadow/normalizeForeshadowRow";
import { publishAuthoritativeForeshadowRows } from "@/features/foreshadow/authoritativeRows";
import {
  computeBodyDiff,
  computeDocDiff,
  type BodyDiff,
} from "@/features/timelapse/bodyDiff";
import {
  createCanonicalWriteContext,
  type CanonicalWriteContext,
  type CanonicalWriteReceipt,
} from "@/features/native-writes/writeContext";

export {
  listCodexMatchTargets,
  type CodexEntryType,
  type CodexMatchRow,
} from "./codexMatchTargets";

const IME_EXPORT_FIELDS = new Set([
  "type",
  "name",
  "aliases",
  "excludedAliases",
  "readings",
  "contextMode",
]);

function affectsImeExport(data: Record<string, unknown>): boolean {
  return Object.keys(data).some((key) => IME_EXPORT_FIELDS.has(key));
}

function nativeNullable(value: string | null | undefined): string | undefined {
  return value === null ? "" : value;
}

export type CodexEntry = typeof codexEntries.$inferSelect;
export type NewCodexEntry = typeof codexEntries.$inferInsert;
export type CodexEntryWriteResult = CodexEntry & {
  __writeReceipt: CanonicalWriteReceipt;
};

function attachWriteReceipt(
  entry: CodexEntry,
  receipt: CanonicalWriteReceipt,
): CodexEntryWriteResult {
  // The receipt is control-plane metadata, not a persisted Codex field. Keep
  // it directly accessible to history wiring without allowing object spreads,
  // Drizzle updates, or JSON snapshots to leak it back into domain state.
  Object.defineProperty(entry, "__writeReceipt", {
    value: receipt,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  return entry as CodexEntryWriteResult;
}

interface NativeCodexWriteResult extends CanonicalWriteReceipt {
  entityId: string;
  version: number;
  undoJournalId: string;
  relatedForeshadows?: unknown[];
}
export const BUILTIN_CODEX_TYPES = [
  "character",
  "location",
  "item",
  "lore",
] as const;
export type BuiltinCodexEntryType = (typeof BUILTIN_CODEX_TYPES)[number];

export async function listCodexEntries(
  projectId: string,
  type?: CodexEntryType,
): Promise<CodexEntry[]> {
  const scope = eq(codexEntries.projectId, projectId);
  return db
    .select()
    .from(codexEntries)
    .where(type ? and(scope, eq(codexEntries.type, type)) : scope);
}

// ---------------------------------------------------------------------------
// M10: 用途別 projection (Phase 1)
// listCodexEntries は全列 SELECT で、重い列 (content=PM JSON 本文 /
// icon=base64 WebP / notes=プライベート PM JSON) を毎回転送していた。
// mention 検出だけの経路・AI 文脈構築の経路・timelapse ベースラインの経路は
// 必要列が固定なので、列を絞った専用 API に分ける。
// codexStore（一覧/編集面/undo が全列に依存）は従来通り listCodexEntries を使う。
// ---------------------------------------------------------------------------

/**
 * AI 文脈構築用: icon / notes / readings の 3 列を除いた行。content は L4 注入・
 * children budget・reverse mention 走査が全件横断で読むため残す。
 * notes は「AI 文脈には注入しない」列 (schema comment 参照)。readings は IME 辞書・
 * ルビ・ソート用のメタデータで物語本文ではないため AI 文脈には注入しない。
 */
export type CodexContextEntry = Omit<CodexEntry, "icon" | "notes" | "readings">;
export type CodexContextMetadataEntry = Omit<CodexContextEntry, "content">;

function codexContextMetadataSelection() {
  return {
    id: codexEntries.id,
    projectId: codexEntries.projectId,
    parentId: codexEntries.parentId,
    type: codexEntries.type,
    name: codexEntries.name,
    aliases: codexEntries.aliases,
    excludedAliases: codexEntries.excludedAliases,
    summary: codexEntries.summary,
    tagsCache: codexEntries.tagsCache,
    contextMode: codexEntries.contextMode,
    childrenBudget: codexEntries.childrenBudget,
    sourceChatMessageId: codexEntries.sourceChatMessageId,
    createdAt: codexEntries.createdAt,
    updatedAt: codexEntries.updatedAt,
    version: codexEntries.version,
  };
}

function codexContextEntrySelection() {
  return {
    ...codexContextMetadataSelection(),
    content: codexEntries.content,
  };
}

/**
 * AI 文脈構築 (chat L4 / エクスポートのキャラクターブック) 用 projection。
 * icon (base64 画像) と notes (注入禁止のプライベートメモ) だけを落とす。
 */
export async function listCodexEntriesForContext(
  projectId: string,
  type?: CodexEntryType,
): Promise<CodexContextEntry[]> {
  const scope = eq(codexEntries.projectId, projectId);
  return db
    .select(codexContextEntrySelection())
    .from(codexEntries)
    .where(type ? and(scope, eq(codexEntries.type, type)) : scope);
}

/**
 * AI 文脈候補選抜用 projection。全件横断で必要な名前・階層・visibility・
 * summary だけを返し、PM JSON 本文(content)を転送しない。
 */
export async function listCodexContextMetadata(
  projectId: string,
  type?: CodexEntryType,
): Promise<CodexContextMetadataEntry[]> {
  const scope = eq(codexEntries.projectId, projectId);
  return db
    .select(codexContextMetadataSelection())
    .from(codexEntries)
    .where(type ? and(scope, eq(codexEntries.type, type)) : scope);
}

/**
 * AI 文脈の本文 materialize 用 projection。候補選抜後の ID だけを読み込む。
 * 戻り順は呼び出し元の ids 順に揃える。
 */
export async function listCodexEntriesForContextByIds(
  projectId: string,
  ids: readonly string[],
): Promise<CodexContextEntry[]> {
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) return [];
  const rows = await db
    .select(codexContextEntrySelection())
    .from(codexEntries)
    .where(
      and(
        eq(codexEntries.projectId, projectId),
        inArray(codexEntries.id, uniqueIds),
      ),
    );
  const byId = new Map(rows.map((row) => [row.id, row] as const));
  return uniqueIds.flatMap((id) => {
    const row = byId.get(id);
    return row ? [row] : [];
  });
}

/** timelapse ベースライン記録用: id + content (PM JSON) のみ。 */
export async function listCodexContentsForBaseline(
  projectId: string,
): Promise<Array<{ id: string; content: string }>> {
  return db
    .select({ id: codexEntries.id, content: codexEntries.content })
    .from(codexEntries)
    .where(eq(codexEntries.projectId, projectId));
}

export async function getCodexEntry(
  projectId: string,
  id: string,
): Promise<CodexEntry | undefined> {
  const rows = await db
    .select()
    .from(codexEntries)
    .where(and(eq(codexEntries.id, id), eq(codexEntries.projectId, projectId)));
  return rows[0];
}

export async function createCodexEntry(
  data: Pick<NewCodexEntry, "id" | "projectId" | "type" | "name"> &
    Partial<
      Pick<
        NewCodexEntry,
        | "summary"
        | "content"
        | "tagsCache"
        | "aliases"
        | "excludedAliases"
        | "readings"
        | "parentId"
        | "contextMode"
        | "icon"
        | "childrenBudget"
        | "notes"
        | "sourceChatMessageId"
      >
    >,
  opts?: {
    suppressImeExport?: boolean;
    writeContext?: CanonicalWriteContext;
  },
): Promise<CodexEntryWriteResult> {
  const writeContext = opts?.writeContext ?? createCanonicalWriteContext();
  const result = await invoke<NativeCodexWriteResult>("codex_create", {
    payload: {
      ...writeContext,
      canonicalPayload: {
        type: data.type,
        name: data.name,
        parentId: data.parentId ?? null,
      },
      entryId: data.id,
      projectId: data.projectId,
      surface: "manual",
      typeSlug: data.type,
      name: data.name,
      summary: data.summary ?? null,
      content: data.content ?? null,
      aliases: data.aliases ?? null,
      excludedAliases: data.excludedAliases ?? null,
      readings: data.readings ?? null,
      tagsCache: data.tagsCache ?? null,
      parentId: data.parentId ?? null,
      contextMode: data.contextMode ?? null,
      icon: data.icon ?? null,
      childrenBudget: data.childrenBudget ?? null,
      notes: data.notes ?? null,
      sourceChatMessageId: data.sourceChatMessageId ?? null,
      model: null,
      chatMessageId: null,
      traceId: null,
      authorshipSpans: [],
    },
  });
  const created = await getCodexEntry(data.projectId, result.entityId);
  if (!created)
    throw new Error(`Codex entry ${result.entityId} was not created`);
  // 段階3: 新規エントリを semantic index へ (debounce + Rust 側 hash 再検証で冪等)。
  scheduleCodexIndex(created.id);
  if (!opts?.suppressImeExport) scheduleImeExportRefresh(data.projectId);
  return attachWriteReceipt(created, {
    changeEventUid: result.changeEventUid,
    maintenanceTransactionId: result.maintenanceTransactionId,
    undoJournalId: result.undoJournalId,
  });
}

type CodexEntryUpdateData = Partial<
  Pick<
    NewCodexEntry,
    | "type"
    | "name"
    | "summary"
    | "content"
    | "tagsCache"
    | "aliases"
    | "excludedAliases"
    | "readings"
    | "parentId"
    | "contextMode"
    | "icon"
    | "childrenBudget"
    | "notes"
  >
>;

function codexUpdateCanonicalPayload(
  current: CodexEntry,
  data: CodexEntryUpdateData,
): { fields: string[]; diffs?: Record<string, BodyDiff> } {
  const fields = Object.keys(data).sort();
  const diffs: Record<string, BodyDiff> = {};
  if (data.content !== undefined) {
    const diff = computeDocDiff(current.content ?? "", data.content ?? "");
    if (diff) diffs.content = diff;
  }
  if (data.summary !== undefined) {
    const diff = computeBodyDiff(current.summary ?? "", data.summary ?? "");
    if (diff) diffs.summary = diff;
  }
  return Object.keys(diffs).length > 0 ? { fields, diffs } : { fields };
}

interface CodexEntryUpdateOptions {
  baseVersion?: number;
  suppressImeExport?: boolean;
  writeContext?: CanonicalWriteContext;
  /**
   * 読み登録の read-modify-write で照合した取得時表記。指定された場合、version
   * を増やさない legacy writer による改名・alias・除外・読み変更も比較検出する。
   */
  baseSurface?: Pick<
    CodexEntry,
    "name" | "aliases" | "excludedAliases" | "readings"
  >;
}

export async function updateCodexEntry(
  projectId: string,
  id: string,
  data: CodexEntryUpdateData,
  opts?: CodexEntryUpdateOptions,
): Promise<CodexEntryWriteResult | undefined> {
  if (
    Object.prototype.hasOwnProperty.call(data, "contextMode") &&
    data.contextMode !== "always" &&
    data.contextMode !== "mentioned"
  ) {
    // Base visibility is inherited by phases. Record the fail-closed marker
    // before a hidden/suppressed/unknown mode can become observable.
    await markImpactBaselinePhasesRestricted(id);
  }
  const current = await getCodexEntry(projectId, id);
  if (!current) return undefined;
  // Native writers always use OCC. Preserve the legacy surface comparison before
  // crossing the boundary so a stale read-modify-write cannot overwrite a rename.
  const baseSurface = opts?.baseSurface;
  if (
    baseSurface &&
    (current.name !== baseSurface.name ||
      current.aliases !== baseSurface.aliases ||
      current.excludedAliases !== baseSurface.excludedAliases ||
      current.readings !== baseSurface.readings)
  ) {
    throw new CodexVersionConflictError(id);
  }
  const baseVersion = opts?.baseVersion ?? current.version;
  const writeContext = opts?.writeContext ?? createCanonicalWriteContext();
  let result: NativeCodexWriteResult;
  try {
    result = await invoke<NativeCodexWriteResult>("codex_update", {
      payload: {
        ...writeContext,
        canonicalPayload: codexUpdateCanonicalPayload(current, data),
        projectId,
        surface: "manual",
        entryId: id,
        baseVersion,
        ...(data.type !== undefined ? { typeSlug: data.type } : {}),
        ...(data.name !== undefined ? { name: nativeNullable(data.name) } : {}),
        ...(data.summary !== undefined
          ? { summary: nativeNullable(data.summary) }
          : {}),
        ...(data.content !== undefined
          ? { content: nativeNullable(data.content) }
          : {}),
        ...(data.aliases !== undefined
          ? { aliases: nativeNullable(data.aliases) }
          : {}),
        ...(data.excludedAliases !== undefined
          ? { excludedAliases: nativeNullable(data.excludedAliases) }
          : {}),
        ...(data.readings !== undefined
          ? { readings: nativeNullable(data.readings) }
          : {}),
        ...(data.tagsCache !== undefined
          ? { tagsCache: nativeNullable(data.tagsCache) }
          : {}),
        ...(data.parentId !== undefined
          ? { parentId: nativeNullable(data.parentId) }
          : {}),
        ...(data.contextMode !== undefined
          ? { contextMode: nativeNullable(data.contextMode) }
          : {}),
        ...(data.icon !== undefined ? { icon: nativeNullable(data.icon) } : {}),
        ...(data.childrenBudget !== undefined
          ? { childrenBudget: nativeNullable(data.childrenBudget) }
          : {}),
        ...(data.notes !== undefined
          ? { notes: nativeNullable(data.notes) }
          : {}),
        model: null,
        chatMessageId: null,
        traceId: null,
        authorshipSpans: null,
        authorshipSpanLanes: null,
      },
    });
  } catch (error) {
    if (String(error).toLowerCase().includes("version conflict")) {
      throw new CodexVersionConflictError(id);
    }
    throw error;
  }
  const updated = await getCodexEntry(projectId, id);
  if (!updated) return undefined;
  if (result?.relatedForeshadows?.length) {
    publishAuthoritativeForeshadowRows(
      result.relatedForeshadows.map(normalizeForeshadowRow),
    );
  }

  // If name/aliases/excludedAliases changed, body-mention cache may be stale
  if (
    data.name !== undefined ||
    data.aliases !== undefined ||
    data.excludedAliases !== undefined
  ) {
    void enqueueRescan(id);
  }

  // 段階3: 埋め込み対象 (name/aliases/summary/content) が変わったら再 index。
  // notes/icon/contextMode 等のみの更新では発火しない (埋め込みに影響しない)。
  if (
    data.name !== undefined ||
    data.aliases !== undefined ||
    data.summary !== undefined ||
    data.content !== undefined
  ) {
    scheduleCodexIndex(id);
  }

  if (affectsImeExport(data) && !opts?.suppressImeExport)
    scheduleImeExportRefresh(projectId);

  return attachWriteReceipt(updated, {
    changeEventUid: result.changeEventUid,
    maintenanceTransactionId: result.maintenanceTransactionId,
    undoJournalId: result.undoJournalId,
  });
}

export async function deleteCodexEntry(
  projectId: string,
  id: string,
  opts?: { writeContext?: CanonicalWriteContext; baseVersion?: number },
): Promise<CanonicalWriteReceipt | undefined> {
  const deletionAuthority = tryAcquireChatAnchorDeletionLease();
  if (!deletionAuthority) throw new ChatAnchorDeletionBlockedError();
  try {
    chatPersistenceDeletionGuard.assertDeletionAllowed();
    const existing = await getCodexEntry(projectId, id);
    const baseVersion = opts?.baseVersion ?? existing?.version;
    if (baseVersion === undefined) return undefined;
    const writeContext = opts?.writeContext ?? createCanonicalWriteContext();
    const result = await invoke<NativeCodexWriteResult>("codex_delete", {
      payload: {
        ...writeContext,
        canonicalPayload: {
          name: existing?.name ?? null,
          type: existing?.type ?? null,
        },
        projectId,
        surface: "manual",
        entryId: id,
        baseVersion,
      },
    });
    notifyCodexAnchorDeletedIfRegistered(id);
    scheduleImeExportRefresh(projectId);
    return {
      changeEventUid: result.changeEventUid,
      maintenanceTransactionId: result.maintenanceTransactionId,
      undoJournalId: result.undoJournalId,
    };
  } finally {
    deletionAuthority.release();
  }
}

export async function listCodexEntriesByMessageId(
  messageId: string,
): Promise<CodexEntry[]> {
  return db
    .select()
    .from(codexEntries)
    .where(eq(codexEntries.sourceChatMessageId, messageId));
}
