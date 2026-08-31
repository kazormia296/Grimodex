import { invoke, isTauri } from "@/lib/tauri";
// isElectron は @/lib/tauri の re-export ではなく実体（@/lib/shell）から
// import する。既存テストが `vi.mock("@/lib/tauri")` を部分 factory で当てて
// も undefined 呼び出しにならないため（panelWindow.ts の supportsPanelWindows
// と同じ作法 — 設計書 §6.5 改訂注記）。
import { isElectron } from "@/lib/shell";
import { attachCreateResultMetadata } from "@/lib/createResultMetadata";
import type {
  TrashItemData,
  TrashItemInput,
  TrashKind,
  TrashSubKind,
  TrashPayload,
} from "./types";
import { getRecorderSessionId } from "@/features/timelapse/recorder";
import { runTimelapseMutation } from "@/features/timelapse/bodyWriteMode";
import { getCurrentProjectId } from "@/application/project/currentProjectAuthority";

/**
 * この実行シェルで trash_bin 5 コマンドがネイティブ実装されているか。
 * Tauri（Rust コマンド）と Electron（napi 垂直スライス — 設計書 §4.3）が対象。
 * plain browser / happy-dom は false（従来どおり create は throw、
 * delete/clear/prune は no-op）。
 */
export function supportsTrashBin(): boolean {
  return isTauri() || isElectron();
}

function toBool(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  return false;
}

function safeJsonParse<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function normalizeTrashItem(raw: unknown): TrashItemData {
  const row = (raw ?? {}) as Record<string, unknown>;
  const payloadRaw = row.payload ?? "{}";
  const previewMetaRaw = row.previewMeta ?? row.preview_meta ?? null;
  return attachCreateResultMetadata(
    {
      id: String(row.id ?? ""),
      projectId: String(row.projectId ?? row.project_id ?? ""),
      kind: String(row.kind ?? "text-fragment") as TrashKind,
      subKind: String(
        row.subKind ?? row.sub_kind ?? "text-fragment",
      ) as TrashSubKind,
      originSceneId:
        (row.originSceneId as string | null | undefined) ??
        (row.origin_scene_id as string | null | undefined) ??
        null,
      originCodexId:
        (row.originCodexId as string | null | undefined) ??
        (row.origin_codex_id as string | null | undefined) ??
        null,
      previewText: String(row.previewText ?? row.preview_text ?? ""),
      previewMeta:
        previewMetaRaw == null
          ? null
          : safeJsonParse<Record<string, unknown>>(previewMetaRaw, {}),
      payload: safeJsonParse<TrashPayload>(payloadRaw, {} as TrashPayload),
      charCount: Number(row.charCount ?? row.char_count ?? 0),
      isInteresting: toBool(row.isInteresting ?? row.is_interesting),
      deletedAt: String(
        row.deletedAt ?? row.deleted_at ?? new Date().toISOString(),
      ),
    },
    raw,
  );
}

interface CreatePayload extends Omit<
  TrashItemInput,
  "previewMeta" | "payload"
> {
  id: string;
  previewMeta: string | null;
  payload: string;
  charCount: number;
  isInteresting: boolean;
  deletedAt?: string;
}

export async function listTrashItems(
  projectId: string,
  limit = 50,
): Promise<TrashItemData[]> {
  const rows = await invoke<unknown[]>("trash_bin_list", { projectId, limit });
  return rows.map(normalizeTrashItem);
}

export async function createTrashItem(
  input: TrashItemInput,
  options: {
    charCount: number;
    isInteresting: boolean;
    deletedAt?: string;
    /** Reuse this domain ID when retrying the same logical create. */
    id?: string;
  },
): Promise<TrashItemData> {
  if (!supportsTrashBin()) {
    throw new Error("trash_bin_create: native shell (tauri/electron) required");
  }
  const payload: CreatePayload = {
    id: options.id ?? crypto.randomUUID(),
    projectId: input.projectId,
    kind: input.kind,
    subKind: input.subKind,
    originSceneId: input.originSceneId,
    originCodexId: input.originCodexId,
    previewText: input.previewText,
    previewMeta:
      input.previewMeta == null ? null : JSON.stringify(input.previewMeta),
    payload: JSON.stringify(input.payload),
    charCount: options.charCount,
    isInteresting: options.isInteresting,
    ...(options.deletedAt === undefined
      ? {}
      : { deletedAt: options.deletedAt }),
  };
  return runTimelapseMutation(input.projectId, async () => {
    const created = await invoke<unknown>("trash_bin_create", { payload });
    return normalizeTrashItem(created);
  });
}

export interface RestoreStructuralTrashOptions {
  requestId?: string;
  boardIdOverride?: string;
  dropX?: number;
  dropY?: number;
}

export interface RestoreStructuralTrashResult {
  newId: string;
  brokenLinks: string[];
}

/**
 * Restore a persisted structure item through the Native aggregate. The domain
 * rows, both ledgers, retry receipt, and Trash consumption share one DB tx.
 */
export async function restoreStructuralTrashItem(
  item: TrashItemData,
  options: RestoreStructuralTrashOptions = {},
): Promise<RestoreStructuralTrashResult> {
  if (!supportsTrashBin()) {
    throw new Error(
      "trash_bin_restore: native shell (tauri/electron) required",
    );
  }
  return runTimelapseMutation(item.projectId, () =>
    invoke<RestoreStructuralTrashResult>("trash_bin_restore", {
      payload: {
        requestId: options.requestId ?? `trash-restore:${item.id}`,
        sessionId: getRecorderSessionId(),
        projectId: item.projectId,
        itemId: item.id,
        boardIdOverride: options.boardIdOverride ?? null,
        dropX: options.dropX ?? null,
        dropY: options.dropY ?? null,
      },
    }),
  );
}

export async function deleteTrashItem(id: string): Promise<void> {
  if (!supportsTrashBin()) return;
  await runTimelapseMutation(getCurrentProjectId(), () =>
    invoke("trash_bin_delete", { id }),
  );
}

export async function clearAllTrashItems(projectId: string): Promise<void> {
  if (!supportsTrashBin()) return;
  await runTimelapseMutation(projectId, () =>
    invoke("trash_bin_clear_all", { projectId }),
  );
}

export async function pruneTrashItems(
  projectId: string,
  retentionDays = 60,
  maxCount = 10_000,
): Promise<number> {
  if (!supportsTrashBin()) return 0;
  return runTimelapseMutation(projectId, () =>
    invoke<number>("trash_bin_prune", {
      projectId,
      retentionDays,
      maxCount,
    }),
  );
}
