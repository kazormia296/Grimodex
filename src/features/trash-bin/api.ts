import { invoke, isTauri } from "@/lib/tauri";
// isElectron は @/lib/tauri の re-export ではなく実体（@/lib/shell）から
// import する。既存テストが `vi.mock("@/lib/tauri")` を部分 factory で当てて
// も undefined 呼び出しにならないため（panelWindow.ts の supportsPanelWindows
// と同じ作法 — 設計書 §6.5 改訂注記）。
import { isElectron } from "@/lib/shell";
import type {
  TrashItemData,
  TrashItemInput,
  TrashKind,
  TrashSubKind,
  TrashPayload,
} from "./types";

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
  return {
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
  };
}

interface CreatePayload extends Omit<
  TrashItemInput,
  "previewMeta" | "payload"
> {
  previewMeta: string | null;
  payload: string;
  charCount: number;
  isInteresting: boolean;
  deletedAt: string;
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
  options: { charCount: number; isInteresting: boolean; deletedAt?: string },
): Promise<TrashItemData> {
  if (!supportsTrashBin()) {
    throw new Error("trash_bin_create: native shell (tauri/electron) required");
  }
  const payload: CreatePayload = {
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
    deletedAt: options.deletedAt ?? new Date().toISOString(),
  };
  const created = await invoke<unknown>("trash_bin_create", { payload });
  return normalizeTrashItem(created);
}

export async function deleteTrashItem(id: string): Promise<void> {
  if (!supportsTrashBin()) return;
  await invoke("trash_bin_delete", { id });
}

export async function clearAllTrashItems(projectId: string): Promise<void> {
  if (!supportsTrashBin()) return;
  await invoke("trash_bin_clear_all", { projectId });
}

export async function pruneTrashItems(
  projectId: string,
  retentionDays = 60,
  maxCount = 10_000,
): Promise<number> {
  if (!supportsTrashBin()) return 0;
  return invoke<number>("trash_bin_prune", {
    projectId,
    retentionDays,
    maxCount,
  });
}
