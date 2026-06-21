/**
 * impact-review の差分計算（純ロジック・IO なし）。
 * Codex エントリの baseline スナップショット ↔ 現在状態を比較し、
 * 「何が変わったか」(ImpactChange[]) と人間可読サマリ・安定 change_id を求める。
 */

import { stableStringify } from "@/features/post-effect/canonicalize";

export type ImpactChangeField =
  | "name"
  | "aliases"
  | "summary"
  | "content"
  | "detail"
  // フェーズ別オーバーライド（フェーズ切替後の上書き）の変更。
  | "phase_summary"
  | "phase_content"
  | "phase_detail";

export interface ImpactChange {
  field: ImpactChangeField;
  /** field='detail'/'phase_detail' のとき detail 名。それ以外は null */
  name: string | null;
  /** field='phase_*' のときフェーズ label。それ以外は省略。 */
  phase?: string;
  old: string;
  new: string;
}

/**
 * フェーズ別オーバーライドのスナップショット。
 * 値は「上書き値」（null=ベース継承）。base content と同様 contentPlain は
 * plain text、details は includeInContext な上書きのみ。
 */
export interface PhaseSnapshot {
  phaseId: string;
  label: string;
  summary: string | null;
  contentPlain: string | null;
  details: Array<{ name: string; value: string }>;
}

/**
 * 差分の対象となる Codex の正規化済みスナップショット。
 * summary/contentPlain は plain text、details は includeInContext な値のみ。
 * phases はフェーズ別オーバーライド（任意・旧 baseline には存在しない）。
 */
export interface CodexSnapshot {
  name: string;
  aliases: string[];
  summary: string;
  contentPlain: string;
  details: Array<{ name: string; value: string }>;
  phases?: PhaseSnapshot[];
}

const EMPTY_SNAPSHOT: CodexSnapshot = {
  name: "",
  aliases: [],
  summary: "",
  contentPlain: "",
  details: [],
  phases: [],
};

/** content/summary の old/new がペイロードを肥大させないための上限。 */
const FIELD_VALUE_CAP = 4000;

/**
 * 比較用キー。空白差・全半角差は無視する（日本語は空白非依存なので全空白除去で十分。
 * 英語でも純粋な空白のみの差だけが無視され、語の置換は依然 differ する）。
 */
function cmp(s: string): string {
  return s.replace(/\s+/g, "").normalize("NFKC");
}

function cap(s: string): string {
  return s.length > FIELD_VALUE_CAP ? s.slice(0, FIELD_VALUE_CAP) + "…" : s;
}

/**
 * baseline（null=初回）と現在状態を比較して変更点を返す。
 * 初回（baseline=null）は空スナップショットと比較する＝非空フィールドを
 * すべて old='' の「変更」として扱い、広く影響判定にかける。
 */
export function computeCodexDiff(
  baseline: CodexSnapshot | null,
  current: CodexSnapshot,
): ImpactChange[] {
  const b = baseline ?? EMPTY_SNAPSHOT;
  const changes: ImpactChange[] = [];

  if (cmp(b.name) !== cmp(current.name)) {
    changes.push({ field: "name", name: null, old: b.name, new: current.name });
  }

  // 正規化済みトークンを区切り文字なしで連結すると ["ab","c"] と ["a","bc"] が
  // 同一キーに潰れて別名編集を取りこぼす。配列を構造ごと stableStringify して
  // 単射なキーにする。
  const aliasKey = (a: string[]) =>
    stableStringify(
      a
        .map(cmp)
        .filter((x) => x !== "")
        .sort(),
    );
  if (aliasKey(b.aliases) !== aliasKey(current.aliases)) {
    changes.push({
      field: "aliases",
      name: null,
      old: b.aliases.join(", "),
      new: current.aliases.join(", "),
    });
  }

  if (cmp(b.summary) !== cmp(current.summary)) {
    changes.push({
      field: "summary",
      name: null,
      old: cap(b.summary),
      new: cap(current.summary),
    });
  }

  if (cmp(b.contentPlain) !== cmp(current.contentPlain)) {
    changes.push({
      field: "content",
      name: null,
      old: cap(b.contentPlain),
      new: cap(current.contentPlain),
    });
  }

  // details: name をキーに union 比較（追加 old=''、削除 new=''）。
  const bByName = new Map(b.details.map((d) => [d.name, d.value]));
  const curByName = new Map(current.details.map((d) => [d.name, d.value]));
  const names: string[] = [];
  const seen = new Set<string>();
  for (const d of [...b.details, ...current.details]) {
    if (!seen.has(d.name)) {
      seen.add(d.name);
      names.push(d.name);
    }
  }
  for (const name of names) {
    const ov = bByName.get(name) ?? "";
    const nv = curByName.get(name) ?? "";
    if (cmp(ov) !== cmp(nv)) {
      changes.push({ field: "detail", name, old: ov, new: nv });
    }
  }

  // phases: phaseId をキーに union 比較。フェーズ別の summary/content/detail
  // オーバーライド（null=ベース継承）を base と同じ規則で diff する。base 説明を
  // フェーズ上書きしていた場合の編集はここで拾う（base のみ見ると取りこぼす）。
  diffPhases(b.phases ?? [], current.phases ?? [], changes);

  return changes;
}

/** フェーズ別オーバーライドの差分を changes に push する。 */
function diffPhases(
  bPhases: PhaseSnapshot[],
  curPhases: PhaseSnapshot[],
  changes: ImpactChange[],
): void {
  const bById = new Map(bPhases.map((p) => [p.phaseId, p]));
  const curById = new Map(curPhases.map((p) => [p.phaseId, p]));
  const phaseIds: string[] = [];
  const seenPhase = new Set<string>();
  for (const p of [...bPhases, ...curPhases]) {
    if (!seenPhase.has(p.phaseId)) {
      seenPhase.add(p.phaseId);
      phaseIds.push(p.phaseId);
    }
  }

  for (const phaseId of phaseIds) {
    const bp = bById.get(phaseId);
    const cp = curById.get(phaseId);
    // label は現在側を優先（削除フェーズは baseline 側）。
    const label = cp?.label ?? bp?.label ?? "";

    const oldSummary = bp?.summary ?? "";
    const newSummary = cp?.summary ?? "";
    if (cmp(oldSummary) !== cmp(newSummary)) {
      changes.push({
        field: "phase_summary",
        name: null,
        phase: label,
        old: cap(oldSummary),
        new: cap(newSummary),
      });
    }

    const oldContent = bp?.contentPlain ?? "";
    const newContent = cp?.contentPlain ?? "";
    if (cmp(oldContent) !== cmp(newContent)) {
      changes.push({
        field: "phase_content",
        name: null,
        phase: label,
        old: cap(oldContent),
        new: cap(newContent),
      });
    }

    const bDetail = new Map((bp?.details ?? []).map((d) => [d.name, d.value]));
    const cDetail = new Map((cp?.details ?? []).map((d) => [d.name, d.value]));
    const detailNames: string[] = [];
    const seenDetail = new Set<string>();
    for (const d of [...(bp?.details ?? []), ...(cp?.details ?? [])]) {
      if (!seenDetail.has(d.name)) {
        seenDetail.add(d.name);
        detailNames.push(d.name);
      }
    }
    for (const name of detailNames) {
      const ov = bDetail.get(name) ?? "";
      const nv = cDetail.get(name) ?? "";
      if (cmp(ov) !== cmp(nv)) {
        changes.push({
          field: "phase_detail",
          name,
          phase: label,
          old: ov,
          new: nv,
        });
      }
    }
  }
}

const FIELD_LABEL: Record<"name" | "aliases" | "summary" | "content", string> =
  {
    name: "名前",
    aliases: "別名",
    summary: "要約",
    content: "本文",
  };

function truncForSummary(s: string): string {
  const t = s.trim();
  if (t === "") return "（空）";
  return t.length > 24 ? t.slice(0, 24) + "…" : t;
}

/** 変更点を「年齢: 15 → 17 / 要約を変更」風の人間可読サマリにする。 */
export function summarizeChanges(changes: ImpactChange[]): string {
  const parts = changes.map((c) => {
    const prefix = c.phase ? `[${c.phase}] ` : "";
    if (c.field === "detail" || c.field === "phase_detail") {
      return `${prefix}${c.name}: ${truncForSummary(c.old)} → ${truncForSummary(c.new)}`;
    }
    if (c.field === "name" || c.field === "aliases") {
      return `${FIELD_LABEL[c.field]}: ${truncForSummary(c.old)} → ${truncForSummary(c.new)}`;
    }
    if (c.field === "phase_summary") return `${prefix}要約を変更`;
    if (c.field === "phase_content") return `${prefix}説明を変更`;
    return `${FIELD_LABEL[c.field]}を変更`;
  });
  return parts.join(" / ");
}

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * 変更集合に対する安定 ID。dismiss_key の名前空間になる（Rust 側が
 * scene_id + change_id + found_text で dismiss_key を作るため、変更が変われば
 * 過去の却下を引き継がない）。
 */
export function computeChangeId(
  entryId: string,
  changes: ImpactChange[],
): string {
  return fnv1a(stableStringify({ entryId, changes }));
}
