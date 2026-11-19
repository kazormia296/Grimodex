import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { codexEntries } from "@/db/schema";
import { debugLog, errorDetail } from "@/lib/debugLog";
import { listPhasesByEntryIds } from "../phaseApi";
import { usePhaseStore } from "../phaseStore";
import { isCodexContextModeHiddenFromAi } from "./codexVisibilityPolicy";
import { resolveCodexContexts } from "./resolvedCodexContext";
import type { TemporalAnchor } from "./sceneTimeIndex";

/** Phase 解決後の、AI へ渡してよい Codex の文（hidden でないものだけ）。 */
export interface CodexTextForAi {
  summary: string | null;
  content: string;
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
 * その文は base ではなく Phase 解決後（chat の通常の文脈と同じ）を返す。base の文は
 * 作者が秘匿と印した内容そのものだからである。
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
  for (const entry of entries) {
    const resolved = resolvedById.get(entry.id);
    const mode = resolved?.contextMode ?? entry.contextMode;
    if (isCodexContextModeHiddenFromAi(mode)) {
      hidden.add(entry.id);
      continue;
    }
    texts.set(entry.id, {
      summary: resolved ? resolved.summary : entry.summary,
      content: resolved ? resolved.content : entry.content,
    });
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
    out.push(
      text && "summary" in row ? { ...row, summary: text.summary } : row,
    );
  }
  return out;
}

/**
 * `ids` から hidden を除いた id を、順序を保って返す。beat・インライン AI のように
 * 検出済みの id の列を持つ経路用。判定に失敗したときは fail-closed で何も渡さない
 * （生成は続けられるが、Codex の要約は付かない）。`summaries` は、Phase で hidden を
 * 解除された Codex が base の要約を運ばないための、Phase 解決後の要約（id 単位）。
 */
export async function visibleCodexForAi(
  ids: readonly string[],
  options: { projectId?: string | null; sceneId?: string | null } = {},
): Promise<{ ids: string[]; summaries: Map<string, string | null> }> {
  if (ids.length === 0) return { ids: [], summaries: new Map() };
  try {
    const { hidden, texts } = await resolveCodexForAi({
      entryIds: ids,
      ...options,
    });
    const summaries = new Map<string, string | null>();
    for (const [id, text] of texts) summaries.set(id, text.summary);
    return { ids: ids.filter((id) => !hidden.has(id)), summaries };
  } catch (error) {
    debugLog.warn(
      "codex-hidden",
      "hidden 判定に失敗したので Codex の要約を渡さない",
      errorDetail(error),
    );
    return { ids: [], summaries: new Map() };
  }
}

/** `visibleCodexForAi` の id だけ版。 */
export async function visibleCodexIdsForAi(
  ids: readonly string[],
  options: { projectId?: string | null; sceneId?: string | null } = {},
): Promise<string[]> {
  return (await visibleCodexForAi(ids, options)).ids;
}
