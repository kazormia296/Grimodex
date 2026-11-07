// 第 6 版の README の観測の節（IR の時間切れ、抽出の失敗、記録の点検）の数値を records から数え直す。
// 読むだけ。agg-v6.mjs／summary-v6.json に無い値の正本で、判断規則には使わない。
//
// 使い方：node obs-v6.mjs <records-m-ja-2-v6.json> <records-g-ja-1-v6.json> [...]
// 出力：標準出力に JSON。中央値は agg-v6.mjs と同じ定義（偶数個は中央 2 つの平均）。
import fs from "node:fs";
import path from "node:path";

export function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

const round1 = (v) => (v === null ? null : Math.round(v * 10) / 10);

/** n・最小・中央値・最大（小数 1 桁）。 */
export function stats(values) {
  const xs = values.filter((v) => typeof v === "number" && Number.isFinite(v));
  if (xs.length === 0) return { n: 0, min: null, median: null, max: null };
  return {
    n: xs.length,
    min: round1(Math.min(...xs)),
    median: round1(median(xs)),
    max: round1(Math.max(...xs)),
  };
}

const isTimeout = (sample) => sample.completion?.outcome === "timeout";

/** 地点ごとの観測（時間切れの分布、所要時間、Raw の後の時間、probe、IR wait、Raw の index）。 */
export function checkpointObservations(records) {
  return records.checkpoints.map((checkpoint) => {
    const samples = checkpoint.queries.flatMap((query) => query.samples);
    const timeouts = samples.filter(isTimeout);
    const others = samples.filter((sample) => !isTimeout(sample));
    const timeoutsPerQuery = { 0: 0, 1: 0, 2: 0, 3: 0 };
    const queriesWithoutTimeout = [];
    const queriesAllTimeout = [];
    for (const query of checkpoint.queries) {
      const n = query.samples.filter(isTimeout).length;
      timeoutsPerQuery[n] = (timeoutsPerQuery[n] ?? 0) + 1;
      if (n === 0) queriesWithoutTimeout.push(query.position);
      if (n === query.samples.length) queriesAllTimeout.push(query.position);
    }
    const tail10 = checkpoint.queries
      .filter((query) => query.tail10)
      .flatMap((query) => query.samples);
    return {
      fraction: checkpoint.fraction,
      sceneCount: checkpoint.sceneCount,
      queries: checkpoint.queries.length,
      samples: samples.length,
      timeouts: timeouts.length,
      timeoutsPerQuery,
      queriesWithoutTimeout,
      queriesAllTimeout,
      tail10: {
        samples: tail10.length,
        timeouts: tail10.filter(isTimeout).length,
      },
      timeoutRawCounts: [...new Set(timeouts.map((sample) => sample.rawCount))],
      durationMs: {
        all: stats(samples.map((sample) => sample.durationMs)),
        timeout: stats(timeouts.map((sample) => sample.durationMs)),
        other: stats(others.map((sample) => sample.durationMs)),
      },
      returnAfterRawMs: {
        all: stats(samples.map((sample) => sample.timing?.returnAfterRawMs)),
        timeout: stats(timeouts.map((sample) => sample.timing?.returnAfterRawMs)),
        other: stats(others.map((sample) => sample.timing?.returnAfterRawMs)),
      },
      probe: {
        queries: checkpoint.queries.length,
        available: checkpoint.queries.filter(
          (query) => query.probe?.status === "available",
        ).length,
      },
      irWait: checkpoint.irWait ?? null,
      raw: checkpoint.raw ?? null,
    };
  });
}

/** 抽出の観測（完了した抽出の時間、失敗の記録、停止の規則、連続する失敗）。 */
export function extractionObservations(records) {
  const entries = Array.isArray(records.extraction)
    ? records.extraction
    : Object.values(records.extraction);
  const completed = entries.filter((entry) => entry.status === "completed");
  const failed = entries.filter((entry) => entry.status !== "completed");
  const byPosition = new Map(entries.map((entry) => [entry.position, entry]));
  return {
    attempted: entries.length,
    completed: completed.length,
    failed: failed.length,
    completedDurationMs: {
      positions1to58: stats(
        completed.filter((e) => e.position <= 58).map((e) => e.durationMs),
      ),
      positions59to117: stats(
        completed.filter((e) => e.position > 58).map((e) => e.durationMs),
      ),
    },
    firstFiveFailed: failed.filter((entry) => entry.position <= 5).length,
    consecutiveFailures: failed
      .filter((entry) => {
        const next = byPosition.get(entry.position + 1);
        return next && next.status !== "completed";
      })
      .map((entry) => entry.position),
    failures: failed.map((entry) => ({
      position: entry.position,
      errorShape: entry.errorShape ?? null,
      failedAtMs: round1(entry.failedAtMs),
      discardMs: round1(entry.discardMs),
      connectionWait: entry.connectionWait
        ? {
            ready: entry.connectionWait.ready,
            waitedMs: round1(entry.connectionWait.waitedMs),
            polls: entry.connectionWait.polls,
          }
        : null,
      chain: (entry.errorChain?.chain ?? []).map((link) => ({
        depth: link.depth,
        name: link.constructorName ?? link.name,
        code: link.code ?? null,
      })),
      truncated: entry.errorChain?.truncated ?? null,
      nextPositionStatus: byPosition.get(entry.position + 1)?.status ?? null,
    })),
  };
}

const CJK = /[぀-ヿ㐀-鿿]/u;
const SECRET_LIKE = /sk-ant|sk-or-|Bearer |AKIA/u;
const SUSPICIOUS_KEY = /title|text|content|body|excerpt|prompt|apiKey|api_key|secret|token|password/iu;

function kindOfLongString(pathName) {
  if (/\.path$/u.test(pathName)) return "path";
  if (/sha256|digest|\$\.harness\.|\$\.build\.artifacts\./iu.test(pathName)) return "sha256";
  if (/^\$\.(ai|design|costEstimateUsd)\./u.test(pathName)) return "design";
  return "other";
}

/** 記録の全文字列の点検（日本語を含む文字列、60 字以上の文字列、secret らしい値、疑わしい key 名）。 */
export function stringAudit(records) {
  let strings = 0;
  const withCjk = [];
  const long = [];
  let secretLike = 0;
  const suspiciousKeys = new Set();
  (function walk(value, pathName) {
    if (typeof value === "string") {
      strings++;
      if (CJK.test(value)) withCjk.push(pathName);
      if (value.length >= 60) long.push({ path: pathName, length: value.length });
      if (SECRET_LIKE.test(value)) secretLike++;
    } else if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${pathName}[${index}]`));
    } else if (value && typeof value === "object") {
      for (const key of Object.keys(value)) {
        if (SUSPICIOUS_KEY.test(key)) suspiciousKeys.add(key);
        walk(value[key], `${pathName}.${key}`);
      }
    }
  })(records, "$");
  const longByKind = {};
  for (const item of long) {
    const kind = kindOfLongString(item.path);
    (longByKind[kind] ??= []).push(`${item.path} (${item.length})`);
  }
  return {
    strings,
    withCjkCount: withCjk.length,
    withCjk,
    longCount: long.length,
    longByKind,
    secretLike,
    suspiciousKeys: [...suspiciousKeys].sort(),
  };
}

export function observe(records) {
  return {
    runId: records.runId,
    role: records.role,
    status: records.status,
    checkpoints: checkpointObservations(records),
    extraction: extractionObservations(records),
    strings: stringAudit(records),
  };
}

function main(argv) {
  const files = argv.slice(2);
  if (files.length === 0) {
    process.stderr.write("usage: node obs-v6.mjs <records.json> [...]\n");
    process.exit(2);
  }
  const works = {};
  for (const file of files) {
    const records = JSON.parse(fs.readFileSync(file, "utf8"));
    works[path.basename(file)] = observe(records);
  }
  const out = {
    definitions: {
      median: "偶数個は中央 2 つの平均（agg-v6.mjs の median と同じ）。小数 1 桁に丸める",
      returnAfterRawMs: "sample の timing.returnAfterRawMs（Raw が返ってから戻るまで）。all は地点の全 sample、timeout は outcome=timeout、other はそれ以外",
      completedDurationMs: "extraction[].durationMs（status=completed。LLM の呼出しを含む）を位置 1〜58 と 59〜117 で分けた",
      longString: "60 字以上の文字列。path／sha256（harness・build の artifact を含む）／design（ai・design・costEstimateUsd）／other に分けた",
    },
    works,
  };
  process.stdout.write(JSON.stringify(out, null, 1) + "\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main(process.argv);
}
