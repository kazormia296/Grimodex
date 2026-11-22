import { attachCreateResultMetadata } from "../../lib/createResultMetadata.js";
import { attachNativeMutationMetadata } from "../../lib/nativeMutationMetadata.js";
import { toBool, toDate, toNullableDate } from "./coerce.js";
import type { ForeshadowLoadBearing, ForeshadowRow } from "./types.js";

export function normalizeForeshadowRow(raw: unknown): ForeshadowRow {
  const row = (raw ?? {}) as Record<string, unknown>;
  return attachNativeMutationMetadata(
    attachCreateResultMetadata(
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
    ),
    raw,
  );
}
