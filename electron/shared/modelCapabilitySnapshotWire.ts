/**
 * 採用済みのモデル能力の写しを renderer へ渡す、読み取り専用の typed IPC の契約（PR-C2、Q17）。
 *
 * 渡すのは、main が検証を通した写し（採用済みの cache、無ければ同梱）だけで、取得を始める入口ではない。
 * renderer はこの値を能力表へ統合する（次の PR）。registry から来る文字列は key（`<provider>/<id>`）
 * だけで、表示や AI への入力にしない（T1）。
 */
import type { ModelEntry, SnapshotSource } from "./modelCapabilityRegistry.js";
import { SNAPSHOT_SOURCES } from "./modelCapabilityRegistry.js";

export const MODEL_CAPABILITY_SNAPSHOT_COMMAND =
  "get_model_capability_snapshot";

/** 採用した写しの出所：app が取得して保存した cache か、app に同梱の写しか。 */
export const MODEL_CAPABILITY_ORIGINS = ["cache", "bundled"] as const;
export type ModelCapabilityOrigin = (typeof MODEL_CAPABILITY_ORIGINS)[number];

export interface ModelCapabilitySnapshotView {
  readonly origin: ModelCapabilityOrigin;
  /** 写しの取得元の刻印（"grimodex"：GitHub の写し。"models.dev"：直接取得は未実装）。 */
  readonly source: SnapshotSource;
  /** 写しの生成日時（ISO 8601 の UTC）。 */
  readonly generatedAt: string;
  readonly models: Readonly<Record<string, ModelEntry>>;
}

/** main が返す値を、renderer 側で形だけ確かめる（main は信頼するが、契約の崩れを早く見つける）。 */
export function parseModelCapabilitySnapshotView(
  value: unknown,
): ModelCapabilitySnapshotView | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(",") !== "generatedAt,models,origin,source") return null;
  const { origin, source, generatedAt, models } = record;
  if (
    typeof origin !== "string" ||
    !(MODEL_CAPABILITY_ORIGINS as readonly string[]).includes(origin)
  ) {
    return null;
  }
  if (
    typeof source !== "string" ||
    !(SNAPSHOT_SOURCES as readonly string[]).includes(source)
  ) {
    return null;
  }
  if (typeof generatedAt !== "string") return null;
  if (typeof models !== "object" || models === null || Array.isArray(models)) {
    return null;
  }
  const checked: Record<string, ModelEntry> = Object.create(null) as Record<
    string,
    ModelEntry
  >;
  for (const [key, entry] of Object.entries(models)) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return null;
    }
    const fields = entry as Record<string, unknown>;
    const out: {
      contextWindow?: number;
      maxOutputTokens?: number;
      toolCall?: boolean;
      reasoning?: boolean;
    } = {};
    for (const [field, fieldValue] of Object.entries(fields)) {
      if (field === "contextWindow" || field === "maxOutputTokens") {
        if (!Number.isSafeInteger(fieldValue) || (fieldValue as number) <= 0) {
          return null;
        }
        out[field] = fieldValue as number;
      } else if (field === "toolCall" || field === "reasoning") {
        if (typeof fieldValue !== "boolean") return null;
        out[field] = fieldValue;
      } else {
        return null;
      }
    }
    checked[key] = out;
  }
  return {
    origin: origin as ModelCapabilityOrigin,
    source: source as SnapshotSource,
    generatedAt,
    models: checked,
  };
}
