import { cmpKeys } from "@/features/tree/fractionalIndex";
import type { EventPrecision } from "@/db/schema";
import { seasonOf, type ChronicleCalendar } from "./chronicleTime";
import { resolveSceneAnchor, type ChronicleAnchor } from "./resolveSceneAnchor";
import type {
  EventRow,
  ParticipantRow,
  EventRelationRow,
  SceneEventRow,
} from "./api";

// ───────── 出力上限（≤600 トークン gate の土台） ─────────
const MAX_RECENT = 8;
const MAX_OFFPAGE = 3;
const MAX_CHARACTERS = 10;
const TITLE_CAP = 40;
const NOTE_CAP = 30;

export type CharacterStatus = "alive" | "dead" | "unborn" | "unknown";

export interface CharacterState {
  codexId: string;
  name: string;
  status: CharacterStatus;
  /** 暦と birth が揃うときのみ年齢。dead は死亡時年齢。不明は null。 */
  age: number | null;
  /** 最後に判明する居場所（codex 名）。不明は null。 */
  location: string | null;
}

export interface SnapshotEvent {
  eventId: string;
  title: string;
  note: string | null;
}

export interface CausalPair {
  causeTitle: string;
  effectTitle: string;
}

export interface ChronicleSnapshot {
  time: {
    source: ChronicleAnchor["source"];
    startTime: number | null;
    season: string | null;
    /** アンカー出来事の日付の確度。none アンカーは null。 */
    precision: EventPrecision | null;
  };
  characters: CharacterState[];
  recentEvents: SnapshotEvent[];
  unresolvedCausal: CausalPair[];
  offpage: SnapshotEvent[];
}

export interface ChronicleSnapshotInput {
  anchor: ChronicleAnchor;
  events: EventRow[];
  participants: ParticipantRow[];
  relations: EventRelationRow[];
  sceneEvents: { sceneId: string; eventId: string }[];
  calendar: ChronicleCalendar | null;
  /** スナップショットに載せる人物 codexId（C4 の pickSnapshotCharacters で絞り込み済み）。 */
  characterIds: string[];
  /** XPROJ 済み codexId→表示名（人物・場所）。 */
  codexNames: Map<string, string>;
}

function truncate(s: string, cap: number): string {
  return s.length > cap ? s.slice(0, cap) + "…" : s;
}

/** ordinal が anchor 以前か（anchor.source=none は ordinal "" のため常に false）。 */
function atOrBefore(ordinal: string, anchorOrdinal: string): boolean {
  if (anchorOrdinal === "") return false;
  return cmpKeys(ordinal, anchorOrdinal) <= 0;
}

/** ある時刻における人物の生死・年齢を導出（純粋）。 */
export function deriveCharacterStateAt(
  characterId: string,
  anchor: ChronicleAnchor,
  events: EventRow[],
  calendar: ChronicleCalendar | null,
): { status: CharacterStatus; age: number | null } {
  const t = anchor.startTime;
  let birthTime: number | null = null;
  let deathTime: number | null = null;
  for (const e of events) {
    if (e.primaryCodexId !== characterId || e.startTime == null) continue;
    if (e.kind === "birth")
      birthTime =
        birthTime == null ? e.startTime : Math.min(birthTime, e.startTime);
    else if (e.kind === "death")
      deathTime =
        deathTime == null ? e.startTime : Math.min(deathTime, e.startTime);
  }

  if (t == null || birthTime == null) return { status: "unknown", age: null };
  if (birthTime > t) return { status: "unborn", age: null };

  const dead = deathTime != null && deathTime <= t;
  const refTime = dead ? (deathTime as number) : t;
  const daysPerYear = calendar?.daysPerYear ?? 0;
  const age =
    daysPerYear > 0 ? Math.floor((refTime - birthTime) / daysPerYear) : null;
  return { status: dead ? "dead" : "alive", age };
}

/** 最後に判明する居場所（純粋）。primary か participant で関与し location 付きの最新 event。 */
export function deriveLastKnownLocation(
  characterId: string,
  anchor: ChronicleAnchor,
  events: EventRow[],
  participantEventIds: Set<string>,
  codexNames: Map<string, string>,
): string | null {
  let best: EventRow | null = null;
  for (const e of events) {
    if (e.locationCodexId == null) continue;
    if (!atOrBefore(e.ordinal, anchor.ordinal)) continue;
    const involved =
      e.primaryCodexId === characterId || participantEventIds.has(e.id);
    if (!involved) continue;
    if (best == null || cmpKeys(e.ordinal, best.ordinal) > 0) best = e;
  }
  if (!best || best.locationCodexId == null) return null;
  return codexNames.get(best.locationCodexId) ?? null;
}

function deriveRecentEvents(
  anchor: ChronicleAnchor,
  events: EventRow[],
): SnapshotEvent[] {
  return events
    .filter(
      (e) => e.kind === "generic" && atOrBefore(e.ordinal, anchor.ordinal),
    )
    .sort((a, b) => cmpKeys(b.ordinal, a.ordinal))
    .slice(0, MAX_RECENT)
    .map((e) => ({
      eventId: e.id,
      title: truncate(e.title, TITLE_CAP),
      note: e.note ? truncate(e.note, NOTE_CAP) : null,
    }));
}

function deriveUnresolvedCausal(
  anchor: ChronicleAnchor,
  events: EventRow[],
  relations: EventRelationRow[],
): CausalPair[] {
  const byId = new Map(events.map((e) => [e.id, e] as const));
  const out: CausalPair[] = [];
  for (const r of relations) {
    const cause = byId.get(r.causeId);
    const effect = byId.get(r.effectId);
    if (!cause || !effect) continue;
    // 原因は起きた（<=anchor）が結果は未到来（>anchor）。
    if (
      atOrBefore(cause.ordinal, anchor.ordinal) &&
      !atOrBefore(effect.ordinal, anchor.ordinal)
    ) {
      out.push({
        causeTitle: truncate(cause.title, TITLE_CAP),
        effectTitle: truncate(effect.title, TITLE_CAP),
      });
    }
  }
  return out;
}

function deriveOffpageEvents(
  anchor: ChronicleAnchor,
  events: EventRow[],
  sceneEvents: { sceneId: string; eventId: string }[],
): SnapshotEvent[] {
  const stamped = new Set(sceneEvents.map((se) => se.eventId));
  const kindRank = (k: EventRow["kind"]) => (k === "generic" ? 1 : 0); // birth/death 優先
  return events
    .filter((e) => !stamped.has(e.id))
    .filter(
      (e) => anchor.source === "none" || atOrBefore(e.ordinal, anchor.ordinal),
    )
    .sort((a, b) => {
      const rk = kindRank(a.kind) - kindRank(b.kind);
      if (rk !== 0) return rk;
      return cmpKeys(b.ordinal, a.ordinal);
    })
    .slice(0, MAX_OFFPAGE)
    .map((e) => ({
      eventId: e.id,
      title: truncate(e.title, TITLE_CAP),
      note: e.note ? truncate(e.note, NOTE_CAP) : null,
    }));
}

/** 構造化スナップショット（正本）を導出。LLM 文字列は renderChronicleSnapshot()。 */
export function deriveChronicleSnapshot(
  input: ChronicleSnapshotInput,
): ChronicleSnapshot {
  const { anchor, events, participants, relations, sceneEvents, calendar } =
    input;

  const season =
    anchor.startTime != null && calendar
      ? seasonOf(anchor.startTime, calendar)
      : null;

  // characterId → 参加 eventId 集合
  const participantsByCodex = new Map<string, Set<string>>();
  for (const p of participants) {
    const set = participantsByCodex.get(p.codexEntryId);
    if (set) set.add(p.eventId);
    else participantsByCodex.set(p.codexEntryId, new Set([p.eventId]));
  }

  const characters: CharacterState[] = input.characterIds
    .slice(0, MAX_CHARACTERS)
    .map((cid) => {
      const { status, age } = deriveCharacterStateAt(
        cid,
        anchor,
        events,
        calendar,
      );
      const location = deriveLastKnownLocation(
        cid,
        anchor,
        events,
        participantsByCodex.get(cid) ?? new Set(),
        input.codexNames,
      );
      return {
        codexId: cid,
        name: input.codexNames.get(cid) ?? cid,
        status,
        age,
        location,
      };
    });

  return {
    time: {
      source: anchor.source,
      startTime: anchor.startTime,
      season,
      precision: anchor.precision,
    },
    characters,
    recentEvents: deriveRecentEvents(anchor, events),
    unresolvedCausal: deriveUnresolvedCausal(anchor, events, relations),
    offpage: deriveOffpageEvents(anchor, events, sceneEvents),
  };
}

const MAX_PICK_CHARACTERS = 10;

/**
 * スナップショットに載せる人物 codexId を選ぶ（Phase 1 固定ルール・純粋）。
 * 0. ユーザーが @mention で明示した人物（mentionedCodexIds）= 最優先 seed。
 *    cap が一杯でも捨てない（「この人物について聞きたい」という明示意図のため）。
 * 1. 現在シーンに L4 注入済みの codex（sceneCodexIds）
 * 2. anchor 以前の直近 K=8 イベントの primaryCodexId と participants
 * none アンカーは状態が定まらないため空（D1: オフページのみ）。@mention 人物も
 * 状態が導出できないので含めない（off-page は別レイヤで扱う）。
 */
export function pickSnapshotCharacters(args: {
  anchor: ChronicleAnchor;
  events: EventRow[];
  participants: ParticipantRow[];
  sceneCodexIds?: string[];
  mentionedCodexIds?: string[];
  max?: number;
}): string[] {
  if (args.anchor.source === "none") return [];
  // @mention 人物を最初に積むことで、Set の挿入順 → 末尾 slice の cap でも
  // 確実に生き残る（明示意図 > scene L4 > recent の優先度）。
  const ids = new Set<string>([
    ...(args.mentionedCodexIds ?? []),
    ...(args.sceneCodexIds ?? []),
  ]);
  const recent = args.events
    .filter((e) => atOrBefore(e.ordinal, args.anchor.ordinal))
    .sort((a, b) => cmpKeys(b.ordinal, a.ordinal))
    .slice(0, MAX_RECENT);
  const recentIds = new Set(recent.map((e) => e.id));
  for (const e of recent) if (e.primaryCodexId) ids.add(e.primaryCodexId);
  for (const p of args.participants)
    if (recentIds.has(p.eventId)) ids.add(p.codexEntryId);
  return [...ids].slice(0, args.max ?? MAX_PICK_CHARACTERS);
}

/**
 * フェッチ済みデータからアンカー解決→人物選定→derive→render までを一括（純粋）。
 * buildSceneContextPrompt（push）と get_chronicle_state ツール（pull）で共用する。
 * 空文字になる場合は undefined（注入スキップ）。
 */
export function assembleChronicleSnapshotText(args: {
  sceneId: string;
  events: EventRow[];
  participants: ParticipantRow[];
  relations: EventRelationRow[];
  sceneEvents: SceneEventRow[];
  calendar: ChronicleCalendar | null;
  readingOrder: Map<string, number>;
  codexNames: Map<string, string>;
  sceneCodexIds?: string[];
  /** @mention で明示された人物 codexId（最優先で snapshot に含める）。 */
  mentionedCodexIds?: string[];
  lang: string;
}): string | undefined {
  const anchor = resolveSceneAnchor(args.sceneId, {
    sceneEvents: args.sceneEvents,
    events: args.events,
    readingOrder: args.readingOrder,
  });
  const characterIds = pickSnapshotCharacters({
    anchor,
    events: args.events,
    participants: args.participants,
    sceneCodexIds: args.sceneCodexIds,
    mentionedCodexIds: args.mentionedCodexIds,
  });
  const snapshot = deriveChronicleSnapshot({
    anchor,
    events: args.events,
    participants: args.participants,
    relations: args.relations,
    sceneEvents: args.sceneEvents,
    calendar: args.calendar,
    characterIds,
    codexNames: args.codexNames,
  });
  const text = renderChronicleSnapshot(snapshot, args.lang);
  return text.trim() ? text : undefined;
}

// ───────── render（lang 別ラベル・純粋） ─────────
interface Labels {
  timeSeason: (season: string) => string;
  timeOrderOnly: string;
  timeProxySuffix: string;
  precisionSuffix: (p: "approx" | "unknown") => string;
  charactersHeader: string;
  status: Record<CharacterStatus, string>;
  age: (n: number) => string;
  location: (loc: string) => string;
  recentHeader: string;
  causalHeader: string;
  causalLine: (cause: string, effect: string) => string;
  offpageHeader: string;
}

const LABELS: Record<"ja" | "en", Labels> = {
  ja: {
    timeSeason: (s) => `作中時刻: ${s}`,
    timeOrderOnly: "作中時刻: 作中順序のみ（暦未設定）",
    timeProxySuffix: "（近傍シーンから推定）",
    precisionSuffix: (p) =>
      p === "approx" ? "（日付はおおよそ）" : "（日付は不確実）",
    charactersHeader: "登場人物の状況:",
    status: { alive: "存命", dead: "故人", unborn: "未誕生", unknown: "不明" },
    age: (n) => `${n}歳`,
    location: (loc) => `所在: ${loc}`,
    recentHeader: "直近の出来事:",
    causalHeader: "未回収の因果:",
    causalLine: (c, e) => `「${c}」→ いずれ「${e}」`,
    offpageHeader: "本文未描写の背景:",
  },
  en: {
    timeSeason: (s) => `Story time: ${s}`,
    timeOrderOnly: "Story time: narrative order only (no calendar)",
    timeProxySuffix: " (estimated from a nearby scene)",
    precisionSuffix: (p) =>
      p === "approx" ? " (date approximate)" : " (date uncertain)",
    charactersHeader: "Character status:",
    status: {
      alive: "alive",
      dead: "deceased",
      unborn: "not yet born",
      unknown: "unknown",
    },
    age: (n) => `age ${n}`,
    location: (loc) => `location: ${loc}`,
    recentHeader: "Recent events:",
    causalHeader: "Unresolved causes:",
    causalLine: (c, e) => `"${c}" → will lead to "${e}"`,
    offpageHeader: "Off-page background:",
  },
};

// ───────── トークン予算（≤600）強制 ─────────
// countTokens(contextBuilder) と同じ heuristic（CJK≒1tok/字・他≒1/3）を複製。
// chronicle module を chat feature に依存させないため import せず複製する。
const CJK_CHAR_RE =
  /[\u3000-\u30ff\u3400-\u9fff\uf900-\ufaff\uff00-\uffef\u{20000}-\u{2ffff}]/gu;
function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = text.match(CJK_CHAR_RE)?.length ?? 0;
  return Math.ceil(cjk + (text.length - cjk) / 3);
}

const RENDER_TOKEN_BUDGET = 600;
const NAME_CAP = 24;

interface RenderLevel {
  recent: number;
  offpage: number;
  notes: boolean;
  charDetail: boolean;
}
// 縮約の優先順（spec §C4: offpage → recent → 詳細 note の順に削る）。
const RENDER_LEVELS: RenderLevel[] = [
  { recent: MAX_RECENT, offpage: MAX_OFFPAGE, notes: true, charDetail: true },
  { recent: MAX_RECENT, offpage: MAX_OFFPAGE, notes: false, charDetail: true },
  { recent: 6, offpage: 2, notes: false, charDetail: true },
  { recent: 4, offpage: 1, notes: false, charDetail: true },
  { recent: 3, offpage: 0, notes: false, charDetail: true },
  { recent: 2, offpage: 0, notes: false, charDetail: false },
  { recent: 0, offpage: 0, notes: false, charDetail: false },
];

function renderAtLevel(
  snapshot: ChronicleSnapshot,
  L: Labels,
  o: RenderLevel,
): string {
  const lines: string[] = [];

  // 時刻（none は出さない）
  if (snapshot.time.source !== "none") {
    let timeLine = snapshot.time.season
      ? L.timeSeason(snapshot.time.season)
      : L.timeOrderOnly;
    if (snapshot.time.source === "proxy") timeLine += L.timeProxySuffix;
    if (
      snapshot.time.precision === "approx" ||
      snapshot.time.precision === "unknown"
    ) {
      timeLine += L.precisionSuffix(snapshot.time.precision);
    }
    lines.push(timeLine);
  }

  if (snapshot.characters.length > 0) {
    lines.push(L.charactersHeader);
    for (const c of snapshot.characters) {
      const parts = [L.status[c.status]];
      if (o.charDetail && c.age != null) parts.push(L.age(c.age));
      if (o.charDetail && c.location) parts.push(L.location(c.location));
      lines.push(`- ${truncate(c.name, NAME_CAP)}: ${parts.join("、")}`);
    }
  }

  const recent = snapshot.recentEvents.slice(0, o.recent);
  if (recent.length > 0) {
    lines.push(L.recentHeader);
    for (const e of recent) {
      lines.push(`- ${e.title}${o.notes && e.note ? `（${e.note}）` : ""}`);
    }
  }

  // 因果は高価値・小サイズなので常に全件。
  if (snapshot.unresolvedCausal.length > 0) {
    lines.push(L.causalHeader);
    for (const c of snapshot.unresolvedCausal) {
      lines.push(`- ${L.causalLine(c.causeTitle, c.effectTitle)}`);
    }
  }

  const offpage = snapshot.offpage.slice(0, o.offpage);
  if (offpage.length > 0) {
    lines.push(L.offpageHeader);
    for (const e of offpage) {
      lines.push(`- ${e.title}${o.notes && e.note ? `（${e.note}）` : ""}`);
    }
  }

  return lines.join("\n");
}

/**
 * 構造化スナップショットを LLM 向けテキストへ（push の static 注入と pull の tool で共用）。
 * ≤600 トークンに収まる最初の詳細度を採用（超過時は offpage→recent→note の順に縮約）。
 *
 * NOTE: ここの ≤600 は `estimateTokens`（heuristic）による soft-cap。実送信時の
 * 予算の正本は contextBuilder 側で、CHRONICLE レイヤは `trimChronicleText` により
 * PLOT_THREAD の次・L5 より先に削られる。encoder ベースの countTokens と heuristic に
 * 乖離があっても、この二次トリムが最終的にコンテキスト窓を守る。
 */
export function renderChronicleSnapshot(
  snapshot: ChronicleSnapshot,
  lang: string,
): string {
  const L = LABELS[lang === "en" ? "en" : "ja"];
  let out = "";
  for (const level of RENDER_LEVELS) {
    out = renderAtLevel(snapshot, L, level);
    if (estimateTokens(out) <= RENDER_TOKEN_BUDGET) return out;
  }
  return out;
}
