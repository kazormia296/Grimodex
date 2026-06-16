/**
 * relation injection 3 アーム eval（決定的・入力側メトリクス）。
 *
 * - off       : relation を一切注入しない
 * - label-only: 現行（fix 後）。expandCodexRelationsBFS depth1 + 関係ラベルのみ
 * - legacy    : 修正前。expandCodexRelationsBFS depth2(×12) + 生 summary も注入
 *
 * ライブ LLM を使わずに「ノイズ量・距離・トークン量・phase-stale リーク」を
 * 決定的に実測する。出力品質（benefit 軸）は scripts/eval-relation-injection.ts
 * のライブ harness 側で計測する。
 */
import type { CodexContext } from "@/features/chat/contextBuilder";
import { expandCodexRelationsBFS } from "./relationExpansion";
import { resolveCodexState, computeGlobalSceneOrder } from "./phaseResolver";
import type { RelationInjectionCorpus } from "./relationInjectionEvalSets";

export type ArmId = "off" | "label-only" | "legacy";

export interface ArmMetrics {
  arm: ArmId;
  /** 注入された relation 由来エントリ */
  injected: CodexContext[];
  injectedCount: number;
  /** seed（シーンで直接言及/pin）でない＝純展開で持ち込まれたエントリ数 */
  offSceneCount: number;
  /** seed の直接の相手でない（depth2 以遠）エントリ数 */
  depth2Count: number;
  /** 注入 summary が phase 解決後と食い違う（時点リーク）件数 */
  phaseStaleCount: number;
  /** 時点リークしたエントリ名（レポート用） */
  staleEntryNames: string[];
  /** relation ブロックとして注入される文字数（payload 量の代理指標） */
  injectedChars: number;
}

/** phase 解決後の summary を返す純関数ラッパ（DB 不要）。 */
export function resolveSummaryAtScene(
  corpus: RelationInjectionCorpus,
  entryId: string,
  sceneId: string | null,
): string | null {
  const entry = corpus.entries.find((e) => e.id === entryId);
  if (!entry) return null;
  const sceneOrder = computeGlobalSceneOrder(corpus.nodes);
  const resolved = resolveCodexState(
    {
      summary: entry.summary,
      content: entry.content,
      contextMode: entry.contextMode,
    },
    corpus.phasesByEntry.get(entryId) ?? [],
    new Map(),
    new Map(),
    sceneId,
    sceneOrder,
  );
  return resolved.summary;
}

/** seed の直接の相手（depth1）エントリ ID 集合を relation から求める。 */
function directNeighborIds(corpus: RelationInjectionCorpus): Set<string> {
  const seeds = new Set(corpus.seedEntryIds);
  const out = new Set<string>();
  for (const r of corpus.relations) {
    if (seeds.has(r.fromCodexId)) out.add(r.toCodexId);
    if (seeds.has(r.toCodexId)) out.add(r.fromCodexId);
  }
  for (const s of seeds) out.delete(s);
  return out;
}

/** 各アームが BFS 展開する relation 由来エントリ。 */
export function expandForArm(
  arm: ArmId,
  corpus: RelationInjectionCorpus,
): CodexContext[] {
  if (arm === "off") return [];
  const exclude = new Set(corpus.seedEntryIds);
  const opts = arm === "label-only" ? { maxDepth: 1 } : undefined; // legacy = default depth2/×12
  return expandCodexRelationsBFS(
    corpus.seedEntryIds,
    corpus.relations,
    corpus.entries,
    exclude,
    opts,
  );
}

/**
 * contextBuilder の relation ブロック描画を模した payload テキスト。
 * label-only は名前＋「経由」行のみ、legacy は「概要」行（生 summary）も足す。
 */
function renderRelationPayload(arm: ArmId, injected: CodexContext[]): string {
  const lines: string[] = [];
  for (const e of injected) {
    lines.push(`- **${e.name}** (${e.type})`);
    if (e.relationVia) lines.push(`  経由: ${e.relationVia}`);
    if (arm === "legacy") {
      const summary = e.summary?.trim() || e.contentFallback || "";
      if (summary) lines.push(`  概要: ${summary}`);
    }
  }
  return lines.join("\n");
}

export function computeArmMetrics(
  arm: ArmId,
  corpus: RelationInjectionCorpus,
): ArmMetrics {
  const injected = expandForArm(arm, corpus);
  const seeds = new Set(corpus.seedEntryIds);
  const direct = directNeighborIds(corpus);

  let phaseStaleCount = 0;
  const staleEntryNames: string[] = [];
  // legacy のみ生 summary を注入する → そこだけ時点リークが起こりうる
  if (arm === "legacy") {
    for (const e of injected) {
      const raw = corpus.entries.find((x) => x.id === e.id)?.summary ?? null;
      const resolved = resolveSummaryAtScene(
        corpus,
        e.id,
        corpus.targetSceneId,
      );
      if ((raw ?? "") !== (resolved ?? "")) {
        phaseStaleCount += 1;
        staleEntryNames.push(e.name);
      }
    }
  }

  const offSceneCount = injected.filter((e) => !seeds.has(e.id)).length;
  const depth2Count = injected.filter((e) => !direct.has(e.id)).length;

  return {
    arm,
    injected,
    injectedCount: injected.length,
    offSceneCount,
    depth2Count,
    phaseStaleCount,
    staleEntryNames,
    injectedChars: renderRelationPayload(arm, injected).length,
  };
}

export function runEval(corpus: RelationInjectionCorpus): ArmMetrics[] {
  return (["off", "label-only", "legacy"] as ArmId[]).map((arm) =>
    computeArmMetrics(arm, corpus),
  );
}

export function formatReport(results: ArmMetrics[]): string {
  const rows = [
    ["arm", "注入数", "off-scene", "depth2", "phase-stale", "payload文字数"],
    ...results.map((r) => [
      r.arm,
      String(r.injectedCount),
      String(r.offSceneCount),
      String(r.depth2Count),
      String(r.phaseStaleCount),
      String(r.injectedChars),
    ]),
  ];
  const widths = rows[0]!.map((_, i) =>
    Math.max(...rows.map((row) => row[i]!.length)),
  );
  const fmt = (row: string[]) =>
    row.map((c, i) => c.padEnd(widths[i]!)).join("  ");
  const stale = results.find((r) => r.staleEntryNames.length > 0);
  const note = stale
    ? `\nphase-stale entries (legacy): ${stale.staleEntryNames.join(", ")}`
    : "";
  return (
    [
      fmt(rows[0]!),
      "-".repeat(fmt(rows[0]!).length),
      ...rows.slice(1).map(fmt),
    ].join("\n") + note
  );
}
