import { attachCreateResultMetadata } from "@/lib/createResultMetadata";
import type { ForeshadowLoadBearing, ForeshadowRow } from "./types";

function toDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === "number") return new Date(value);
  if (typeof value === "string") return new Date(value);
  return new Date(0);
}

function toNullableDate(value: unknown): Date | null {
  if (value == null) return null;
  return toDate(value);
}

function toBool(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  return false;
}

export function normalizeForeshadowRow(raw: unknown): ForeshadowRow {
  const row = (raw ?? {}) as Record<string, unknown>;
  return attachCreateResultMetadata(
    {
      id: String(row.id ?? ""),
      projectId: String(row.projectId ?? row.project_id ?? ""),
      title: String(row.title ?? ""),
      intent: (row.intent as string | null | undefined) ?? null,
      notes: (row.notes as string | null | undefined) ?? null,
      payoffSceneId:
        (row.payoffSceneId as string | null | undefined) ??
        (row.payoff_scene_id as string | null | undefined) ??
        null,
      payoffFromPos:
        (row.payoffFromPos as number | null | undefined) ??
        (row.payoff_from_pos as number | null | undefined) ??
        null,
      payoffToPos:
        (row.payoffToPos as number | null | undefined) ??
        (row.payoff_to_pos as number | null | undefined) ??
        null,
      payoffConfirmed: toBool(row.payoffConfirmed ?? row.payoff_confirmed),
      abandoned: toBool(row.abandoned),
      secret: toBool(row.secret ?? false),
      loadBearing:
        ((row.loadBearing ?? row.load_bearing) as
          | ForeshadowLoadBearing
          | null
          | undefined) ?? null,
      version: Number(row.version ?? 0),
      codexLinkDirtyAt: toNullableDate(
        row.codexLinkDirtyAt ?? row.codex_link_dirty_at,
      ),
      createdAt: toDate(row.createdAt ?? row.created_at),
      updatedAt: toDate(row.updatedAt ?? row.updated_at),
    },
    raw,
  );
}
