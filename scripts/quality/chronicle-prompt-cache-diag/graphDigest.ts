/**
 * 診断（diagnostic only）専用。出力（観測グラフ・仮説）の正規化 digest と、どの部分が違うかを
 * 示す部分ごとの digest。id・乱数・本文は含めない（digest だけを返す）。
 */
import { digestStableJson } from "@/features/narrative-extraction/source/digest";
import type { NarrativeActualGraph } from "@/features/narrative-extraction/eval/types";

export interface HypothesisLike {
  readonly actuality: string;
  readonly significance: string;
  readonly semanticType?: string;
  readonly observationRefs: readonly string[];
}

export interface GraphDigest {
  readonly digest: string;
  /** 部分ごとの digest。run 間・形の間で違う部分を特定するために使う。 */
  readonly parts: Record<string, string>;
}

const RANDOM_KEY_PREFIX = "production-observation:";

export async function graphDigest(
  actual: NarrativeActualGraph,
  hypotheses: readonly HypothesisLike[],
): Promise<GraphDigest> {
  const observations = actual.observations.map((observation) => ({
    // Gold に対応づかなかった観測の semanticKey は localId（乱数）を含むので潰す。
    semanticKey: observation.semanticKey.startsWith(RANDOM_KEY_PREFIX)
      ? `${RANDOM_KEY_PREFIX}*`
      : observation.semanticKey,
    dimensions: observation.dimensions,
  }));
  const parts: Record<string, string> = {};
  const dimensionNames = new Set(
    observations.flatMap((entry) => Object.keys(entry.dimensions)),
  );
  parts.semanticKeys = await digestStableJson(
    observations.map((entry) => entry.semanticKey).sort(),
  );
  for (const name of [...dimensionNames].sort()) {
    parts[`dimension:${name}`] = await digestStableJson(
      observations
        .map((entry) =>
          JSON.stringify({
            semanticKey: entry.semanticKey,
            value: (entry.dimensions as Record<string, unknown>)[name] ?? null,
          }),
        )
        .sort(),
    );
  }
  parts.hypotheses = await digestStableJson(
    hypotheses
      .map((hypothesis) =>
        JSON.stringify({
          actuality: hypothesis.actuality,
          significance: hypothesis.significance,
          semanticType: hypothesis.semanticType ?? null,
          observationCount: hypothesis.observationRefs.length,
        }),
      )
      .sort(),
  );
  parts.coverageClaims = await digestStableJson(actual.coverageClaims ?? []);
  const digest = await digestStableJson({
    observations: observations.map((entry) => JSON.stringify(entry)).sort(),
    hypotheses: parts.hypotheses,
    coverageClaims: parts.coverageClaims,
  });
  return { digest, parts };
}

/** 渡した run の parts のうち、run 間で値が一致しない部分の名前（昇順）。 */
export function differingParts(
  partsList: readonly Record<string, string>[],
): string[] {
  const names = new Set(partsList.flatMap((parts) => Object.keys(parts)));
  return [...names]
    .filter(
      (name) => new Set(partsList.map((parts) => parts[name] ?? "")).size > 1,
    )
    .sort();
}

export type EnumHistograms = Record<string, Record<string, number>>;

const ENUM_DIMENSIONS = [
  "actuality",
  "attribution",
  "narrativeFrame",
  "significance",
  "proposalGate",
] as const;

/**
 * 列挙値（actuality・attribution・narrativeFrame・significance・proposalGate）の件数分布。
 * 値は閉じた列挙（本文ではない）なので report に載せてよい。差の向きを見るための補助。
 */
export function enumHistograms(actual: NarrativeActualGraph): EnumHistograms {
  const result: EnumHistograms = {};
  for (const name of ENUM_DIMENSIONS) {
    const counts: Record<string, number> = {};
    for (const observation of actual.observations) {
      const dimension = (
        observation.dimensions as Record<
          string,
          { status: string; value?: unknown } | undefined
        >
      )[name];
      if (dimension?.status !== "observed") continue;
      // attribution は "character:<名前>" の自由文字列を含むので、名前は落として種別だけを数える。
      const raw = String(dimension.value);
      const value = raw.startsWith("character:") ? "character" : raw;
      counts[value] = (counts[value] ?? 0) + 1;
    }
    result[name] = Object.fromEntries(Object.entries(counts).sort());
  }
  return result;
}
