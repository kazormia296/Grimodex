#!/usr/bin/env node
/**
 * モデル能力の registry の「写し」を、保存済みの models.dev の応答（file）から生成・検証する（PR-C2）。
 * 設計の正本は docs/plans/model-capability-runtime-fetch-precheck.md の §4 と §7.3。
 *
 * このスクリプトは通信しない。入力は引数で渡す file だけで、取得は後の workflow の PR が担う。
 * 検証 module（electron/shared/modelCapabilityRegistry.ts）は import なしの 1 file で、Node 22.18 以降は
 * 型の除去が既定で有効なので、install なしで `.ts` を直接 import できる。
 *
 * 使い方:
 *   node scripts/generate-model-capability-snapshot.mjs generate <models.dev の応答> \
 *     --generated-at 2026-11-18T15:28:51Z [--out <出力 file>]
 *   node scripts/generate-model-capability-snapshot.mjs check [<写しの file>]
 *   node scripts/generate-model-capability-snapshot.mjs compare --base <master の写し> \
 *     (--candidate <候補の file> | --candidate-dir <artifact の directory>) \
 *     [--report <json>] [--summary <md>] [--pr-title <txt>] [--pr-body <md>] [--github-output <file>]
 *   node scripts/generate-model-capability-snapshot.mjs same-models --a <PR の枝の写し> --b <候補> [--github-output <file>]
 *   node scripts/generate-model-capability-snapshot.mjs raw-limit
 *
 * generate: normalizeModelsDev → canonicalize → parseSnapshot の順に通し、自己検証してから書く。
 *   途中で 1 つでも失敗したら、出力 file には触れず、非 0 で終わる。`source` は常に "grimodex"。
 * check: file が parseSnapshot を通り、`source` が "grimodex" で、書式が generate の出力と
 *   1 byte も違わないことを確かめる（CI と試験の入口）。
 *
 * compare: 定期 workflow（.github/workflows/update-model-capabilities.yml）の判断の本体。候補を自分で
 *   検証し直し（check と同じ）、master の写しと比べ、変更の有無・draft の判定・PR の title と本文を
 *   決める。生成 job と PR 作成 job の両方が実行し、PR 作成 job は生成 job の結果を信頼しない。
 *   出力は件数・真偽・列挙した code・検証を通した id だけで、upstream の文字列は出さない。
 *   候補が拒否されたとき（stale／generated-at-conflict／schema 等）は非 0 で終わり、PR を作らない。
 *   急減（shrunk）だけは拒否でなく draft の PR にする（Q9。人の確認を必須にする）。
 * same-models: 2 つの写しの models が generatedAt を除いて同じかを `same=true|false` で出す（既存の PR の枝の
 *   写しと候補が同じなら、定期 workflow は push しない）。
 * raw-limit: models.dev の応答の byte 数の上限（SNAPSHOT_POLICY.maxRawBytes）を出す。curl の上限に使う。
 *
 * 失敗の出力は code と件数だけで、入力の本文は出さない。
 */
import {
  appendFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  canonicalize,
  compareSnapshots,
  normalizeModelsDev,
  parseModelsDevText,
  parseSnapshot,
  SNAPSHOT_POLICY,
  SNAPSHOT_PROVIDERS,
} from "../electron/shared/modelCapabilityRegistry.ts";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/** 同梱の写しの repo 内の path。master の raw 配信の path と同じ（app の定数と試験が一致を確かめる）。 */
export const SNAPSHOT_REPO_PATH = "electron/resources/model-capabilities.json";
const DEFAULT_OUT = path.join(rootDir, SNAPSHOT_REPO_PATH);

/**
 * repo に置く書式。1 model を 1 行にして、更新 PR の diff を読めるようにする（canonicalize は
 * 1 行で diff に向かない）。key の順は canonicalize と同じ（辞書順）。末尾に改行を 1 つ付ける。
 * parseSnapshot は空白を問わないので、この書式の file も検証を通る。
 */
export function formatSnapshotFile(snapshot) {
  const canonical = JSON.parse(canonicalize(snapshot));
  const lines = Object.keys(canonical.models).map(
    (key) =>
      `    ${JSON.stringify(key)}: ${JSON.stringify(canonical.models[key])}`,
  );
  return (
    `{\n` +
    `  "generatedAt": ${JSON.stringify(canonical.generatedAt)},\n` +
    `  "models": {\n${lines.join(",\n")}\n  },\n` +
    `  "schemaVersion": ${canonical.schemaVersion},\n` +
    `  "source": ${JSON.stringify(canonical.source)}\n` +
    `}\n`
  );
}

function countFindings(findings) {
  const counts = new Map();
  for (const finding of findings) {
    const add = typeof finding.count === "number" ? finding.count : 1;
    counts.set(finding.code, (counts.get(finding.code) ?? 0) + add);
  }
  return [...counts].map(([code, count]) => `${code}=${count}`).join(" ");
}

function providerCounts(snapshot) {
  const counts = new Map();
  for (const key of Object.keys(snapshot.models)) {
    const provider = key.slice(0, key.indexOf("/"));
    counts.set(provider, (counts.get(provider) ?? 0) + 1);
  }
  return [...counts]
    .map(([provider, count]) => `${provider}=${count}`)
    .join(" ");
}

/** generate の本体。失敗は Error（message は code だけ）。 */
export function generateSnapshotText(rawText, generatedAt, nowMs) {
  const raw = parseModelsDevText(rawText, SNAPSHOT_POLICY);
  if (!raw.ok) throw new Error(`models.dev の応答を読めません: ${raw.code}`);
  const normalized = normalizeModelsDev(raw.value, SNAPSHOT_POLICY, {
    generatedAt,
    source: "grimodex",
  });
  if (!normalized.ok) {
    throw new Error(`models.dev の応答を変換できません: ${normalized.code}`);
  }
  const canonicalText = canonicalize(normalized.snapshot);
  const parsed = parseSnapshot(canonicalText, SNAPSHOT_POLICY, { nowMs });
  if (!parsed.ok) throw new Error(`生成した写しの検証に失敗: ${parsed.code}`);
  // 自己検証：変換の結果は、検証を通した後も 1 件も落ちていない（正規形が完全に一致する）。
  if (canonicalize(parsed.snapshot) !== canonicalText) {
    throw new Error("生成した写しの検証で内容が変わりました");
  }
  return {
    text: formatSnapshotFile(parsed.snapshot),
    snapshot: parsed.snapshot,
    digest: parsed.digest,
    findings: [...normalized.findings, ...parsed.findings],
  };
}

/** check の本体。file の text を検証し、書式の一致まで確かめる。 */
export function checkSnapshotText(text, nowMs) {
  const parsed = parseSnapshot(text, SNAPSHOT_POLICY, { nowMs });
  if (!parsed.ok) throw new Error(`写しの検証に失敗: ${parsed.code}`);
  if (parsed.snapshot.source !== "grimodex") {
    throw new Error("写しの source が grimodex ではありません");
  }
  if (parsed.findings.length > 0) {
    throw new Error(
      `写しに捨てられる項目があります: ${countFindings(parsed.findings)}`,
    );
  }
  if (formatSnapshotFile(parsed.snapshot) !== text) {
    throw new Error("写しの書式が generate の出力と一致しません");
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// 定期 workflow の判断（compare）。純関数にして、fixture で試験する。
// ---------------------------------------------------------------------------

/**
 * 更新 PR を draft にする閾値と、古さの警告の日数。SNAPSHOT_POLICY には無い値で、定期 workflow の
 * 実装（2026-11-19）で新設し、同日にユーザー確認で確定した値。急減の判定は
 * SNAPSHOT_POLICY の minCountRatio 等を compareSnapshots 経由でそのまま使う。
 */
export const REVIEW_POLICY = Object.freeze({
  /** context-changed／capability-changed／field-removed／provider-removed の合計（切られた分を含む）がこれを超えたら draft。 */
  maxAttentionFindings: 20,
  /** （追加＋削除＋変更）が前回の件数のこの割合を超えたら draft（大量の変更）。 */
  maxChurnRatio: 0.2,
  /** master の写しの generatedAt がこの日数より古いと警告を出す（T10）。 */
  staleWarningDays: 30,
  /** 候補の generatedAt の未来側の許容。CI の時計から取った値なので、実行時の 1 日より厳しくする。 */
  maxCandidateFutureSkewMs: 300_000,
});

/** draft の理由。この集合の外の値は report に載らない。 */
export const DRAFT_REASONS = Object.freeze([
  "shrunk",
  "provider-removed",
  "many-attention-findings",
  "high-churn",
]);

const DRAFT_REASON_TEXT = Object.freeze({
  shrunk:
    "件数が急減しました（前回の割合の下限を下回る）。配布済みの app は、同梱の写しとの比較でこの写しを拒否します（急減の検知）。merge すると、次の release の同梱の写しが新しい基準になります。",
  "provider-removed": "前回にあった provider が丸ごと無くなりました。",
  "many-attention-findings": `context の大きな増減・tool／reasoning の反転・field の消失などの検出が ${REVIEW_POLICY.maxAttentionFindings} 件を超えました。`,
  "high-churn": `追加・削除・変更の合計が前回の件数の ${Math.round(REVIEW_POLICY.maxChurnRatio * 100)}% を超えました。`,
});

const ATTENTION_CODES = new Set([
  "context-changed",
  "capability-changed",
  "field-removed",
  "provider-removed",
]);
const ENTRY_KEYS = [
  "contextWindow",
  "maxOutputTokens",
  "toolCall",
  "reasoning",
];
const GENERATED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
/** model の key（`<provider>/<id>`）の形。registry の id の形と同じで、Markdown の記号や空白を含められない。 */
const MODEL_KEY_PATTERN =
  /^[a-z0-9]+\/~?[a-z0-9][a-z0-9.-]*(?:\/[a-z0-9][a-z0-9.-]*)?(?::[a-z0-9.-]+)?$/;
const REJECT_CODES = new Set(["stale", "generated-at-conflict", "schema"]);
const DAY_MS = 86_400_000;
/** 候補の file 名（artifact の中の唯一の file）。 */
export const CANDIDATE_FILE_NAME = "model-capabilities.json";

function diffModels(base, next) {
  let added = 0;
  let removed = 0;
  let changed = 0;
  // maxOutputTokens の値から値への変化（compareSnapshots は報告しない）。本文の注意の欄に出す。
  const outputChanges = { total: 0, items: [] };
  for (const key of Object.keys(next.models)) {
    const before = base.models[key];
    if (before === undefined) {
      added += 1;
      continue;
    }
    const after = next.models[key];
    if (ENTRY_KEYS.some((field) => before[field] !== after[field])) {
      changed += 1;
    }
    if (
      before.maxOutputTokens !== undefined &&
      after.maxOutputTokens !== undefined &&
      before.maxOutputTokens !== after.maxOutputTokens
    ) {
      outputChanges.total += 1;
      if (outputChanges.items.length < SNAPSHOT_POLICY.maxFindings) {
        outputChanges.items.push({
          key,
          from: before.maxOutputTokens,
          to: after.maxOutputTokens,
        });
      }
    }
  }
  for (const key of Object.keys(base.models)) {
    if (next.models[key] === undefined) removed += 1;
  }
  return { added, removed, changed, outputChanges };
}

function providerTable(base, next) {
  const count = (snapshot, provider) =>
    Object.keys(snapshot.models).filter((key) => key.startsWith(`${provider}/`))
      .length;
  return SNAPSHOT_PROVIDERS.map((provider) => ({
    provider,
    base: count(base, provider),
    candidate: count(next, provider),
  }));
}

/**
 * 候補（定期 workflow が生成した写し）を、master の写しと比べて判断する。
 * 候補は check と同じ検証をここで通し直す（生成した job を信頼しない）。拒否は Error ではなく
 * `status: "rejected"` で返す（summary に理由を残すため）。検証そのものの失敗は Error。
 *
 * 返す report は、数値・真偽・検証した時刻・列挙した code・検証を通した key だけを持つ。
 */
export function evaluateUpdate({ baseText, candidateText, nowMs }) {
  const base = parseSnapshot(baseText, SNAPSHOT_POLICY, { nowMs });
  if (!base.ok) throw new Error(`master の写しの検証に失敗: ${base.code}`);
  const candidate = checkSnapshotText(candidateText, nowMs);
  const candidateMs = Date.parse(candidate.snapshot.generatedAt);
  if (candidateMs > nowMs + REVIEW_POLICY.maxCandidateFutureSkewMs) {
    throw new Error("候補の generatedAt が現在の時計より未来です");
  }
  const baseMs = Date.parse(base.snapshot.generatedAt);
  const baseAgeDays = Math.max(0, Math.floor((nowMs - baseMs) / DAY_MS));
  const { outputChanges, ...diff } = diffModels(
    base.snapshot,
    candidate.snapshot,
  );
  const common = {
    version: 1,
    baseGeneratedAt: base.snapshot.generatedAt,
    candidateGeneratedAt: candidate.snapshot.generatedAt,
    baseAgeDays,
    baseStale: baseAgeDays > REVIEW_POLICY.staleWarningDays,
    counts: {
      base: Object.keys(base.snapshot.models).length,
      candidate: Object.keys(candidate.snapshot.models).length,
      ...diff,
    },
    providers: providerTable(base.snapshot, candidate.snapshot),
    digest: candidate.digest,
    outputChanges,
  };
  if (diff.added === 0 && diff.removed === 0 && diff.changed === 0) {
    // generatedAt だけが違う写しは更新としない（毎回 PR になるのを避ける）。
    return {
      ...common,
      status: "unchanged",
      rejectCode: null,
      draft: false,
      draftReasons: [],
      attentionTotal: 0,
      findings: [],
      outputChanges: { total: 0, items: [] },
    };
  }
  const compared = compareSnapshots(
    base.snapshot,
    candidate.snapshot,
    SNAPSHOT_POLICY,
  );
  if (!compared.ok && compared.code !== "shrunk") {
    return {
      ...common,
      status: "rejected",
      rejectCode: REJECT_CODES.has(compared.code) ? compared.code : "schema",
      draft: false,
      draftReasons: [],
      attentionTotal: 0,
      findings: [],
      outputChanges: { total: 0, items: [] },
    };
  }
  const findings = compared.findings;
  const reasons = new Set();
  if (!compared.ok) reasons.add("shrunk");
  let attentionTotal = 0;
  for (const finding of findings) {
    if (ATTENTION_CODES.has(finding.code)) attentionTotal += 1;
    if (finding.code === "findings-truncated") {
      attentionTotal += finding.count ?? 0;
    }
    if (finding.code === "provider-removed") reasons.add("provider-removed");
  }
  if (attentionTotal > REVIEW_POLICY.maxAttentionFindings) {
    reasons.add("many-attention-findings");
  }
  const churn = diff.added + diff.removed + diff.changed;
  if (churn > common.counts.base * REVIEW_POLICY.maxChurnRatio) {
    reasons.add("high-churn");
  }
  const draftReasons = DRAFT_REASONS.filter((reason) => reasons.has(reason));
  return {
    ...common,
    status: "changed",
    rejectCode: null,
    draft: draftReasons.length > 0,
    draftReasons,
    attentionTotal,
    findings,
  };
}

function safeInteger(value) {
  return Number.isSafeInteger(value) ? String(value) : "?";
}

function safeValue(value) {
  if (typeof value === "boolean") return String(value);
  return safeInteger(value);
}

function safeKey(key) {
  if (typeof key !== "string") return null;
  if (SNAPSHOT_PROVIDERS.includes(key)) return key;
  if (key.length > SNAPSHOT_POLICY.maxKeyLength) return null;
  return MODEL_KEY_PATTERN.test(key) ? key : null;
}

/** key は検証を通ったものだけを、必ず code span で出す（`~` 始まりの id の autolink 等を避ける）。 */
function codeKey(key) {
  const safe = safeKey(key);
  return safe === null ? "（key を省略）" : `\`${safe}\``;
}

function renderFinding(finding) {
  const field = ENTRY_KEYS.includes(finding.field) ? finding.field : null;
  switch (finding.code) {
    case "models-added":
      return `追加された model: ${safeInteger(finding.count)} 件`;
    case "models-removed":
      return `削除された model: ${safeInteger(finding.count)} 件`;
    case "model-count-dropped":
      return `model の件数の急減: ${safeInteger(finding.from)} → ${safeInteger(finding.to)}`;
    case "model-retention-dropped":
      return `前回の model が残った件数の急減: ${safeInteger(finding.from)} → ${safeInteger(finding.to)}`;
    case "provider-count-dropped":
      return `${codeKey(finding.key)} の件数の急減: ${safeInteger(finding.from)} → ${safeInteger(finding.to)}`;
    case "provider-retention-dropped":
      return `${codeKey(finding.key)} の前回の model が残った件数の急減: ${safeInteger(finding.from)} → ${safeInteger(finding.to)}`;
    case "provider-removed":
      return `${codeKey(finding.key)} が丸ごと無くなった（前回 ${safeInteger(finding.from)} 件）`;
    case "context-changed":
      return `${codeKey(finding.key)} の contextWindow: ${safeInteger(finding.from)} → ${safeInteger(finding.to)}`;
    case "capability-changed":
      return `${codeKey(finding.key)} の ${field ?? "（field を省略）"}: ${safeValue(finding.from)} → ${safeValue(finding.to)}`;
    case "field-removed":
      return `${codeKey(finding.key)} の ${field ?? "（field を省略）"} が無くなった（前回 ${safeValue(finding.from)}）`;
    case "findings-truncated":
      return `上限のため省略した検出: ${safeInteger(finding.count)} 件`;
    default:
      return null;
  }
}

function dateOf(generatedAt) {
  return GENERATED_AT_PATTERN.test(generatedAt) ? generatedAt : "?";
}

function providerLines(report) {
  return report.providers.map(
    (row) =>
      `| \`${row.provider}\` | ${safeInteger(row.base)} | ${safeInteger(row.candidate)} |`,
  );
}

/** PR の title。日付は検証済みの generatedAt だけから作る。 */
export function renderPrTitle(report) {
  const day = dateOf(report.candidateGeneratedAt).slice(0, 10);
  return `chore(chat): モデル能力の写しを更新する (${day})\n`;
}

/** PR の本文。数値・検証済みの時刻・列挙した理由・検証を通した key だけから組み立てる。 */
export function renderPrBody(report) {
  const { counts } = report;
  const lines = [
    "## モデル能力の写しの更新",
    "",
    "定期 workflow（`.github/workflows/update-model-capabilities.yml`）が models.dev から生成した、モデル能力の写し（`electron/resources/model-capabilities.json`）の更新です。変更するのはこの 1 file だけです。",
    "",
    "| 項目 | 値 |",
    "|---|---|",
    `| 生成時刻（UTC） | ${dateOf(report.candidateGeneratedAt)} |`,
    `| 前回の生成時刻（UTC） | ${dateOf(report.baseGeneratedAt)} |`,
    `| model 件数 | ${safeInteger(counts.base)} → ${safeInteger(counts.candidate)} |`,
    `| 追加 | ${safeInteger(counts.added)} |`,
    `| 削除 | ${safeInteger(counts.removed)} |`,
    `| 変更 | ${safeInteger(counts.changed)} |`,
    `| 正規形の digest | \`${/^[0-9a-f]{64}$/.test(report.digest) ? report.digest : "?"}\` |`,
    "",
    "### provider 別の件数",
    "",
    "| provider | 前回 | 今回 |",
    "|---|---|---|",
    ...providerLines(report),
    "",
  ];
  if (report.draft) {
    lines.push(
      "### 確認が要る点",
      "",
      "この PR は **draft** です。内容を人が確認し、問題が無ければ人が ready にしてから merge します。workflow は draft に戻すことだけをし、ready にはしません（auto-merge も使いません）。",
      "",
      ...DRAFT_REASONS.filter((reason) =>
        report.draftReasons.includes(reason),
      ).map((reason) => `- ${DRAFT_REASON_TEXT[reason]}`),
      "",
    );
  }
  const rendered = report.findings
    .map(renderFinding)
    .filter((line) => line !== null);
  // maxOutputTokens の変化（compareSnapshots は報告しない）。key は検証し直し、値は整数だけを出す。
  const outputChanges = report.outputChanges ?? { total: 0, items: [] };
  for (const item of outputChanges.items) {
    rendered.push(
      `${codeKey(item.key)} の maxOutputTokens: ${safeInteger(item.from)} → ${safeInteger(item.to)}`,
    );
  }
  if (outputChanges.total > outputChanges.items.length) {
    rendered.push(
      `上限のため省略した maxOutputTokens の変化: ${safeInteger(outputChanges.total - outputChanges.items.length)} 件`,
    );
  }
  if (rendered.length > 0) {
    lines.push(
      `### 検出（最大 ${SNAPSHOT_POLICY.maxFindings} 件）`,
      "",
      ...rendered.map((line) => `- ${line}`),
      "",
    );
  }
  lines.push(
    "### 検証",
    "",
    "- 生成 job は models.dev の応答を上限付きで取得し、検証 module で変換・自己検証しました。",
    "- この PR を作った job は、artifact の script を実行せず、base の版の検証 module で写しを検証し直し（`parseSnapshot`、`source`、書式、`compareSnapshots`）、この本文を組み立てました。",
    "- 本文は件数・時刻・検証を通した id だけで作っています（upstream の文字列は展開しません）。",
    "",
  );
  return lines.join("\n");
}

/** job の summary（Markdown）。T10 の古さの警告も出す。 */
export function renderSummary(report) {
  const lines = ["### モデル能力の写し", ""];
  if (report.baseStale) {
    lines.push(
      `> **警告**: master の写しの生成から ${safeInteger(report.baseAgeDays)} 日経っています（${REVIEW_POLICY.staleWarningDays} 日超）。models.dev に変更が無いか、更新 PR が merge されていない可能性があります。`,
      "",
    );
  }
  lines.push(
    `- 判定: ${report.status}${report.rejectCode ? `（${report.rejectCode}）` : ""}`,
    `- master の生成時刻: ${dateOf(report.baseGeneratedAt)}（${safeInteger(report.baseAgeDays)} 日前）`,
    `- 候補の生成時刻: ${dateOf(report.candidateGeneratedAt)}`,
    `- 件数: ${safeInteger(report.counts.base)} → ${safeInteger(report.counts.candidate)}（追加 ${safeInteger(report.counts.added)}、削除 ${safeInteger(report.counts.removed)}、変更 ${safeInteger(report.counts.changed)}）`,
  );
  if (report.status === "changed") {
    lines.push(`- PR: ${report.draft ? "draft で作る" : "通常の PR で作る"}`);
    for (const reason of report.draftReasons) {
      lines.push(`  - draft の理由: \`${reason}\``);
    }
  }
  if (report.status === "unchanged") {
    lines.push("- models.dev に差分が無いので PR は作りません。");
  }
  if (report.status === "rejected") {
    lines.push("- 候補を拒否しました。PR は作りません。");
  }
  return `${lines.join("\n")}\n`;
}

function readRegularFile(file, maxBytes) {
  const stat = lstatSync(file);
  if (!stat.isFile()) throw new Error("通常の file ではありません");
  if (stat.size > maxBytes) throw new Error("file が大きすぎます");
  return readFileSync(file, "utf8");
}

/** artifact の directory から候補を読む。通常の directory の中の唯一の通常の file だけを受け入れる（symlink・余分な file を拒否）。 */
export function readCandidateFromDir(dir) {
  if (!lstatSync(dir).isDirectory()) {
    throw new Error("artifact の directory が通常の directory ではありません");
  }
  const entries = readdirSync(dir);
  if (entries.length !== 1 || entries[0] !== CANDIDATE_FILE_NAME) {
    throw new Error("artifact は候補の写し 1 file だけでなければなりません");
  }
  return readRegularFile(
    path.join(dir, CANDIDATE_FILE_NAME),
    SNAPSHOT_POLICY.maxSnapshotBytes,
  );
}

/**
 * 2 つの写しの models が、generatedAt を除いて同じか。a が検証を通らなければ「違う」（上書きしてよい）。
 * b（候補）が検証を通らなければ例外。定期 workflow が、PR の枝の写しと候補を比べて、同じなら
 * push しないために使う（毎週の上書きを避ける）。
 */
export function sameModels(aText, bText, nowMs) {
  const b = parseSnapshot(bText, SNAPSHOT_POLICY, { nowMs });
  if (!b.ok) throw new Error(`候補の検証に失敗: ${b.code}`);
  const a = parseSnapshot(aText, SNAPSHOT_POLICY, { nowMs });
  if (!a.ok) return false;
  return (
    canonicalize({ ...a.snapshot, generatedAt: b.snapshot.generatedAt }) ===
    canonicalize(b.snapshot)
  );
}

function runSameModels(options) {
  const a = options.get("--a");
  const b = options.get("--b");
  if (!a || !b) throw new Error("same-models には --a と --b が要ります");
  const same = sameModels(
    readRegularFile(a, SNAPSHOT_POLICY.maxSnapshotBytes),
    readRegularFile(b, SNAPSHOT_POLICY.maxSnapshotBytes),
    Date.now(),
  );
  const outputFile = options.get("--github-output");
  if (outputFile) appendFileSync(outputFile, `same=${same}\n`, "utf8");
  console.log(`same=${same}`);
}

function runCompare(options) {
  const baseFile = options.get("--base");
  const candidateFile = options.get("--candidate");
  const candidateDir = options.get("--candidate-dir");
  if (
    !baseFile ||
    (candidateFile === undefined) === (candidateDir === undefined)
  ) {
    throw new Error(
      "compare には --base と、--candidate か --candidate-dir のどちらか 1 つが要ります",
    );
  }
  const report = evaluateUpdate({
    baseText: readRegularFile(baseFile, SNAPSHOT_POLICY.maxSnapshotBytes),
    candidateText:
      candidateDir !== undefined
        ? readCandidateFromDir(candidateDir)
        : readRegularFile(candidateFile, SNAPSHOT_POLICY.maxSnapshotBytes),
    nowMs: Date.now(),
  });
  const reportFile = options.get("--report");
  if (reportFile)
    writeAtomic(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  const summaryFile = options.get("--summary");
  if (summaryFile) appendFileSync(summaryFile, renderSummary(report), "utf8");
  if (report.status === "changed") {
    const titleFile = options.get("--pr-title");
    if (titleFile) writeAtomic(titleFile, renderPrTitle(report));
    const bodyFile = options.get("--pr-body");
    if (bodyFile) writeAtomic(bodyFile, renderPrBody(report));
  }
  if (report.baseStale) {
    console.log(
      `::warning title=モデル能力の写しが古い::master の写しの生成から ${safeInteger(report.baseAgeDays)} 日経っています`,
    );
  }
  if (report.status === "rejected") {
    throw new Error(`更新の候補を拒否しました: ${report.rejectCode}`);
  }
  const outputFile = options.get("--github-output");
  if (outputFile) {
    appendFileSync(
      outputFile,
      `changed=${report.status === "changed"}\ndraft=${report.draft}\nstale=${report.baseStale}\n`,
      "utf8",
    );
  }
  console.log(
    `status=${report.status} draft=${report.draft} models=${report.counts.base}->${report.counts.candidate} ` +
      `added=${report.counts.added} removed=${report.counts.removed} changed=${report.counts.changed}` +
      (report.draftReasons.length > 0
        ? ` reasons=${report.draftReasons.join(",")}`
        : ""),
  );
}

function writeAtomic(target, text) {
  mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text, "utf8");
    renameSync(tmp, target);
  } finally {
    rmSync(tmp, { force: true });
  }
}

function parseArgs(argv) {
  const positional = [];
  const options = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith("--")) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${arg} には値が要ります`);
      }
      options.set(arg, value);
      index += 1;
    } else {
      positional.push(arg);
    }
  }
  return { positional, options };
}

function main(argv) {
  const { positional, options } = parseArgs(argv);
  const [command, input] = positional;
  const nowMs = Date.now();
  if (command === "generate") {
    if (!input || positional.length !== 2) {
      throw new Error("generate には models.dev の応答 file を 1 つ渡します");
    }
    const generatedAt = options.get("--generated-at");
    if (!generatedAt) {
      throw new Error(
        "--generated-at（ISO 8601 の UTC、例 2026-11-18T15:28:51Z）が要ります",
      );
    }
    const out = options.get("--out") ?? DEFAULT_OUT;
    const result = generateSnapshotText(
      readFileSync(input, "utf8"),
      generatedAt,
      nowMs,
    );
    writeAtomic(out, result.text);
    console.log(
      `wrote ${out}\n` +
        `models=${Object.keys(result.snapshot.models).length} (${providerCounts(result.snapshot)})\n` +
        `digest=${result.digest}\n` +
        `findings: ${countFindings(result.findings) || "none"}`,
    );
    return;
  }
  if (command === "check") {
    const target = input ?? DEFAULT_OUT;
    const parsed = checkSnapshotText(readFileSync(target, "utf8"), nowMs);
    console.log(
      `ok ${target}\nmodels=${Object.keys(parsed.snapshot.models).length} (${providerCounts(parsed.snapshot)})\ndigest=${parsed.digest}`,
    );
    return;
  }
  if (command === "compare") {
    if (positional.length !== 1)
      throw new Error("compare に位置引数は要りません");
    runCompare(options);
    return;
  }
  if (command === "same-models") {
    if (positional.length !== 1) {
      throw new Error("same-models に位置引数は要りません");
    }
    runSameModels(options);
    return;
  }
  if (command === "raw-limit") {
    console.log(String(SNAPSHOT_POLICY.maxRawBytes));
    return;
  }
  throw new Error(
    "使い方: generate <models.dev の応答> --generated-at <時刻> | check [<file>] | compare --base <file> --candidate <file> | same-models --a <file> --b <file> | raw-limit",
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "失敗しました");
    process.exitCode = 1;
  }
}
