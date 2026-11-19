import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { codexEntries } from "@/db/schema";
import { debugLog, errorDetail } from "@/lib/debugLog";
import { listRawDetailValuesByEntryIds } from "../detailApi";
import {
  listDetailOverridesByPhaseIds,
  listPhasesByEntryIds,
} from "../phaseApi";
import { usePhaseStore } from "../phaseStore";
import { isCodexContextModeHiddenFromAi } from "./codexVisibilityPolicy";
import { resolveCodexContexts } from "./resolvedCodexContext";
import type { TemporalAnchor } from "./sceneTimeIndex";

/** Phase 解決後の、AI へ渡してよい Codex の文（hidden でないものだけ）。 */
export interface CodexTextForAi {
  summary: string | null;
  content: string;
  /**
   * base の mode が hidden（または不明）で、Phase 解決後は hidden でないもの。
   * true のときだけ summary・content・detailValues が Phase 解決後で、false なら base の文
   * （hidden でない項目の文は今までどおり base のまま返す）。
   */
  released: boolean;
  /** Phase 解決後の mode（解決結果が無ければ base）。 */
  mode: string;
  /**
   * released で `withDetails` のときだけ。Phase 解決後の詳細値（definitionId → 値。null は
   * Phase による消去）。base の詳細は作者が秘匿した状態の値なので、これを使う。
   */
  detailValues?: ReadonlyMap<string, string | null>;
}

export interface CodexAiResolution {
  /** hidden・不明な mode・DB に無い id。 */
  hidden: Set<string>;
  /** hidden でない id の、Phase 解決後の summary と本文。 */
  texts: Map<string, CodexTextForAi>;
}

/**
 * 作者が hidden（AI に秘匿）と印した Codex の判定と、hidden でないものの Phase 解決後の
 * 文（summary・本文）を一度に返す。
 *
 * 契機を持たない AI 経路（chat の agent tool、beat、インライン AI）が、chat の通常の
 * 文脈と同じ判定で hidden を落とすための共通の入口。判定は chat と同じく、候補を
 * Phase 解決してから `codexVisibilityPolicy` の正本で行う。anchor は
 * `nonSceneContextSource` と同じ規則で、現在の場面があればその場面、なければ base。
 *
 * base が hidden でも現在の場面の Phase で mentioned 等に解除されたものは通すが、
 * その文は base ではなく Phase 解決後（chat の通常の文脈と同じ）を返す（`released`）。
 * base の文は作者が秘匿と印した内容そのものだからである。base が hidden でない項目の
 * 文は置き換えない（`released` が false で base の文のまま）。
 *
 * fail-closed：DB に無い id・不明な mode も hidden に数える。suppress・mentioned・
 * Phase による絞り込みは足さない（全部開示、hidden だけを守る）。
 * `withContent` が false なら本文は DB から読まず空文字で返す（要約だけの経路用）。
 */
export async function resolveCodexForAi(input: {
  entryIds: readonly string[];
  projectId?: string | null;
  /** 現在の場面。空・未指定なら base で解決する。 */
  sceneId?: string | null;
  withContent?: boolean;
  /** true なら、released の項目に Phase 解決後の詳細値（detailValues）を付ける。 */
  withDetails?: boolean;
}): Promise<CodexAiResolution> {
  const ids = [...new Set(input.entryIds)];
  const hidden = new Set<string>();
  const texts = new Map<string, CodexTextForAi>();
  if (ids.length === 0) return { hidden, texts };

  const baseColumns = {
    id: codexEntries.id,
    summary: codexEntries.summary,
    contextMode: codexEntries.contextMode,
  };
  const rows = await db
    .select(
      input.withContent
        ? { ...baseColumns, content: codexEntries.content }
        : baseColumns,
    )
    .from(codexEntries)
    .where(
      input.projectId
        ? and(
            eq(codexEntries.projectId, input.projectId),
            inArray(codexEntries.id, ids),
          )
        : inArray(codexEntries.id, ids),
    );
  const found = new Set<string>();
  const entries = [];
  for (const row of rows) {
    found.add(row.id);
    entries.push({
      id: row.id,
      summary: row.summary,
      contextMode: row.contextMode,
      content: "content" in row ? (row.content ?? "") : "",
    });
  }
  for (const id of ids) if (!found.has(id)) hidden.add(id);
  if (entries.length === 0) return { hidden, texts };

  const phases = await listPhasesByEntryIds(entries.map((entry) => entry.id));
  const { sceneTimeIndex, resolutionMode } = usePhaseStore.getState();
  const sceneId = input.sceneId?.trim();
  const anchor: TemporalAnchor = sceneId
    ? { kind: "scene", sceneId }
    : { kind: "base" };
  const { resolvedById } = resolveCodexContexts({
    entries,
    phases,
    anchor,
    sceneTimeIndex,
    resolutionMode,
  });
  const released: typeof entries = [];
  for (const entry of entries) {
    const resolved = resolvedById.get(entry.id);
    const mode = resolved?.contextMode ?? entry.contextMode;
    if (isCodexContextModeHiddenFromAi(mode)) {
      hidden.add(entry.id);
      continue;
    }
    // 置き換えは「base が hidden（または不明）で、解決後が hidden でない」項目だけ。
    const isReleased =
      resolved !== undefined &&
      isCodexContextModeHiddenFromAi(entry.contextMode);
    if (isReleased) released.push(entry);
    texts.set(entry.id, {
      summary: isReleased ? resolved.summary : entry.summary,
      content: isReleased ? resolved.content : entry.content,
      released: isReleased,
      mode,
    });
  }
  if (input.withDetails && released.length > 0) {
    // 詳細は Phase の override と base の値から解決する（chat の sceneContextSource と同じ形）。
    const releasedIds = released.map((entry) => entry.id);
    const releasedPhases = phases.filter((phase) =>
      releasedIds.includes(phase.entryId),
    );
    const overrides = await listDetailOverridesByPhaseIds(
      releasedPhases.map((phase) => phase.id),
    );
    const rawDetails = await listRawDetailValuesByEntryIds(releasedIds);
    const baseDetailsByEntry = new Map<string, Map<string, string | null>>();
    for (const detail of rawDetails) {
      const values =
        baseDetailsByEntry.get(detail.entryId) ??
        new Map<string, string | null>();
      values.set(detail.definitionId, detail.value);
      baseDetailsByEntry.set(detail.entryId, values);
    }
    const detailResolved = resolveCodexContexts({
      entries: released,
      phases: releasedPhases,
      phaseDetailOverrides: overrides,
      baseDetailsByEntry,
      anchor,
      sceneTimeIndex,
      resolutionMode,
    }).resolvedById;
    for (const entry of released) {
      const text = texts.get(entry.id);
      const detailValues = detailResolved.get(entry.id)?.detailValues;
      if (text && detailValues) texts.set(entry.id, { ...text, detailValues });
    }
  }
  return { hidden, texts };
}

/** hidden の id だけが要るとき用。判定は `resolveCodexForAi` と同じ。 */
export async function listCodexIdsHiddenFromAi(input: {
  entryIds: readonly string[];
  projectId?: string | null;
  sceneId?: string | null;
}): Promise<Set<string>> {
  return (await resolveCodexForAi(input)).hidden;
}

/**
 * `resolveCodexForAi` で hidden の行を除く。順序は保つ。`summary` を持つ行は、Phase で
 * hidden を解除されたものが base の文を運ばないよう、Phase 解決後の summary に置き換える。
 */
export async function dropCodexHiddenFromAi<T extends { id: string }>(
  rows: readonly T[],
  options: { projectId?: string | null; sceneId?: string | null } = {},
): Promise<T[]> {
  if (rows.length === 0) return [];
  const { hidden, texts } = await resolveCodexForAi({
    entryIds: rows.map((row) => row.id),
    ...options,
  });
  const out: T[] = [];
  for (const row of rows) {
    if (hidden.has(row.id)) continue;
    const text = texts.get(row.id);
    // 置き換えるのは、Phase で hidden を解除された（base が hidden だった）項目だけ。
    out.push(
      text?.released && "summary" in row
        ? { ...row, summary: text.summary }
        : row,
    );
  }
  return out;
}

/**
 * `ids` から hidden を除いた id を、順序を保って返す。beat・インライン AI のように
 * 検出済みの id の列を持つ経路用。判定に失敗したときは fail-closed で何も渡さない
 * （生成は続けられるが、Codex の要約は付かない）。`summaries` は、Phase で hidden を
 * 解除された Codex（base が hidden だったもの）だけが、base の要約を運ばないための、
 * Phase 解決後の要約（id 単位）。ほかの項目は含まれず、呼び側の base の要約のまま。
 */
export async function visibleCodexForAi(
  ids: readonly string[],
  options: { projectId?: string | null; sceneId?: string | null } = {},
): Promise<{
  ids: string[];
  summaries: Map<string, string | null>;
  /** 渡してよいもののうち、Phase 解決後の mode が suppress の id（呼び側が必要なら除く）。 */
  suppressed: Set<string>;
}> {
  if (ids.length === 0)
    return { ids: [], summaries: new Map(), suppressed: new Set() };
  try {
    const { hidden, texts } = await resolveCodexForAi({
      entryIds: ids,
      ...options,
    });
    const summaries = new Map<string, string | null>();
    const suppressed = new Set<string>();
    for (const [id, text] of texts) {
      if (text.released) summaries.set(id, text.summary);
      if (text.mode === "suppress") suppressed.add(id);
    }
    return { ids: ids.filter((id) => !hidden.has(id)), summaries, suppressed };
  } catch (error) {
    debugLog.warn(
      "codex-hidden",
      "hidden 判定に失敗したので Codex の要約を渡さない",
      errorDetail(error),
    );
    return { ids: [], summaries: new Map(), suppressed: new Set() };
  }
}

/** `visibleCodexForAi` の id だけ版。 */
export async function visibleCodexIdsForAi(
  ids: readonly string[],
  options: { projectId?: string | null; sceneId?: string | null } = {},
): Promise<string[]> {
  return (await visibleCodexForAi(ids, options)).ids;
}
