/**
 * 作中年表（chronicle）context injection の **ライブ** eval（出力品質 / benefit 軸）。
 *
 * relationInjectionEval.live.test.ts と同型。決定的 eval が入力側を測るのに対し、
 * こちらは実 LLM で各アームの**出力**を生成し、judge モデルで軸を採点する。
 *
 * 検証対象は 2 つ:
 *   1. @mention 人物スコープ（新機能）: ユーザーが画面外キャラを @mention すると、
 *      その人物の年表状態（生死・所在）が注入され、LLM がそれを尊重するか。
 *   2. 年表スナップショット注入一般の価値。
 *
 * 3 アーム（注入する年表ブロックだけが差分）:
 *   - off    : 年表ブロック無し。
 *   - inject : 既定スナップショット（mentionedCodexIds=[]）。画面外の老王ゴランは出ない。
 *   - mention: ゴランを @mention（mentionedCodexIds=[goran]）。ゴランの「故人・流刑の島」
 *              という状態が強制的に注入される。
 *
 * **決定的サニティ（LLM 呼び出し前に必ず assert）**: mention スナップショットには
 * 「ゴラン」と「故人」が含まれ、inject/off には含まれないことを確認する。これにより
 * アームが本当に差分を持つことが保証される（fixture が壊れていれば即落ちる）。
 *
 * 既定では live 部分は SKIP。実行するにはキーを渡す:
 *   OPENROUTER_API_KEY=sk-... pnpm test --run \
 *     src/features/chronicle/chronicleInjectionEval.live.test.ts
 * モデル上書き: OPENROUTER_MODEL / OPENROUTER_JUDGE_MODEL。実トークン課金あり。
 */
import { describe, it, expect } from "vitest";
import {
  assembleChronicleSnapshotText,
  pickSnapshotCharacters,
} from "./chronicleSnapshot";
import { resolveSceneAnchor } from "./resolveSceneAnchor";
import { generateNKeysBetween } from "@/features/tree/fractionalIndex";
import {
  DEFAULT_SEASON_BOUNDARIES,
  type ChronicleCalendar,
} from "./chronicleTime";
import type {
  EventRow,
  ParticipantRow,
  SceneEventRow,
  EventRelationRow,
} from "./api";

const KEY = process.env.OPENROUTER_API_KEY;
const GEN_MODEL = process.env.OPENROUTER_MODEL ?? "openai/gpt-4o-mini";
const JUDGE_MODEL = process.env.OPENROUTER_JUDGE_MODEL ?? "openai/gpt-4o";
const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

async function callOpenRouter(
  model: string,
  messages: ChatMessage[],
  opts?: { json?: boolean; temperature?: number; maxTokens?: number },
): Promise<string> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://github.com/kazormia296/Grimodex",
      "X-Title": "Grimodex chronicle-injection eval",
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: opts?.temperature ?? 0.7,
      max_tokens: opts?.maxTokens ?? 1024,
      ...(opts?.json ? { response_format: { type: "json_object" } } : {}),
    }),
  });
  if (!res.ok) {
    throw new Error(`OpenRouter ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  return data.choices?.[0]?.message?.content ?? "";
}

// ───────── in-memory chronicle fixture（DB 無し・純オブジェクト） ─────────
//
// 主人公アリス（現在シーンのキャラ）と、画面外の老王ゴランが居る。
// ゴランは「流刑→崩御」という重い経歴を持つが、シーン参加者でもアンカー直近 8 件
// イベントにも入らないため、既定スナップショットには出ない。@mention で初めて出る。

const PROJECT = "proj-chronicle-eval";
const CODEX = {
  alice: "codex-alice",
  goran: "codex-goran",
  capital: "codex-capital",
  exileIsle: "codex-exile-isle",
  frontier: "codex-frontier",
} as const;

const SCENE_PROLOGUE = "scene-prologue";
const SCENE_CURRENT = "scene-current";

const CODEX_NAMES = new Map<string, string>([
  [CODEX.alice, "アリス"],
  [CODEX.goran, "ゴラン"],
  [CODEX.capital, "王都"],
  [CODEX.exileIsle, "流刑の島"],
  [CODEX.frontier, "辺境の村"],
]);

const CALENDAR: ChronicleCalendar = {
  daysPerYear: 360,
  seasonBoundaries: DEFAULT_SEASON_BOUNDARIES,
};

// 8 件のアリス道中イベント（アンカー直前の「直近」を埋め、ゴランを窓外へ押し出す）。
const FILLER_TITLES = [
  "アリス、辺境の村で剣を学ぶ",
  "盗賊団の襲撃を村人とともに退ける",
  "焼け落ちた砦から古い地図を見つける",
  "村長から王都の異変の噂を聞く",
  "旅の仲間と別れ、単身で旅立つ",
  "峠道で季節外れの吹雪に遭う",
  "国境の関所を身分を隠して抜ける",
  "王都郊外の宿場町に到達する",
];

// ordinal は最古→最新。14 = goran3 + aliceBirth + 8 filler + anchor + future。
const ORD = generateNKeysBetween(null, null, 14);

function mkEvent(
  e: Partial<EventRow> & { id: string; ordinal: string; title: string },
): EventRow {
  return {
    id: e.id,
    projectId: PROJECT,
    title: e.title,
    note: e.note ?? null,
    detail: e.detail ?? null,
    ordinal: e.ordinal,
    primaryCodexId: e.primaryCodexId ?? null,
    locationCodexId: e.locationCodexId ?? null,
    startTime: e.startTime ?? null,
    endTime: e.endTime ?? null,
    startMinute: e.startMinute ?? null,
    endMinute: e.endMinute ?? null,
    startGranularity: e.startGranularity ?? "none",
    endGranularity: e.endGranularity ?? "none",
    precision: e.precision ?? "exact",
    kind: e.kind ?? "generic",
    secret: e.secret ?? false,
    revealSceneId: e.revealSceneId ?? null,
    laneGroup: e.laneGroup ?? null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

const EV = {
  goranBirth: "ev-goran-birth",
  aliceBirth: "ev-alice-birth",
  goranExile: "ev-goran-exile",
  goranDeath: "ev-goran-death",
  anchor: "ev-anchor",
  future: "ev-future",
} as const;

const EVENTS: EventRow[] = [
  mkEvent({
    id: EV.goranBirth,
    ordinal: ORD[0]!,
    title: "ゴラン、王都に生まれる",
    primaryCodexId: CODEX.goran,
    locationCodexId: CODEX.capital,
    startTime: 0,
    kind: "birth",
  }),
  mkEvent({
    id: EV.aliceBirth,
    ordinal: ORD[1]!,
    title: "アリス誕生",
    primaryCodexId: CODEX.alice,
    locationCodexId: CODEX.frontier,
    startTime: 14400, // 40 年後
    kind: "birth",
  }),
  mkEvent({
    id: EV.goranExile,
    ordinal: ORD[2]!,
    title: "ゴラン王、簒奪者に追われ流刑の島へ",
    primaryCodexId: CODEX.goran,
    locationCodexId: CODEX.exileIsle,
    startTime: 18000, // 50 年
    kind: "generic",
  }),
  mkEvent({
    id: EV.goranDeath,
    ordinal: ORD[3]!,
    title: "老王ゴラン、流刑の島で崩御",
    primaryCodexId: CODEX.goran,
    locationCodexId: CODEX.exileIsle,
    startTime: 18360, // ゴラン 51 歳で死亡
    kind: "death",
  }),
  ...FILLER_TITLES.map((title, i) =>
    mkEvent({
      id: `ev-filler-${i + 1}`,
      ordinal: ORD[4 + i]!,
      title,
      primaryCodexId: CODEX.alice,
      locationCodexId: CODEX.frontier,
      startTime: 21600 + i, // すべてゴラン死後・アンカー直前
      kind: "generic",
    }),
  ),
  mkEvent({
    id: EV.anchor,
    ordinal: ORD[12]!,
    title: "アリス、王都へ向かう決意",
    primaryCodexId: CODEX.alice,
    locationCodexId: CODEX.frontier,
    startTime: 21650, // 現在シーンの時刻（アリス 20 歳）
    kind: "generic",
  }),
  mkEvent({
    id: EV.future,
    ordinal: ORD[13]!,
    title: "王都、崩落の刻",
    locationCodexId: CODEX.capital,
    startTime: 22000, // アンカーより未来（未回収の因果）
    kind: "generic",
  }),
];

// ゴランの 3 イベントは「序章」シーンに stamp 済 → off-page 一覧から除外され、
// 既定スナップショットの本文未描写背景にもゴラン名が漏れない。
// 現在シーンは anchor イベントに stamp（stamped アンカー）。
const SCENE_EVENTS: SceneEventRow[] = [
  { sceneId: SCENE_PROLOGUE, eventId: EV.goranBirth },
  { sceneId: SCENE_PROLOGUE, eventId: EV.goranExile },
  { sceneId: SCENE_PROLOGUE, eventId: EV.goranDeath },
  { sceneId: SCENE_CURRENT, eventId: EV.anchor },
];

const PARTICIPANTS: ParticipantRow[] = [
  { eventId: EV.anchor, codexEntryId: CODEX.alice, role: "視点" },
  { eventId: "ev-filler-8", codexEntryId: CODEX.alice, role: "視点" },
];

// 未回収の因果（一般的な年表価値を強める / ゴラン非依存）。
const RELATIONS: EventRelationRow[] = [
  { causeId: EV.anchor, effectId: EV.future },
];

const READING_ORDER = new Map<string, number>([
  [SCENE_PROLOGUE, 0],
  [SCENE_CURRENT, 1],
]);

function buildSnapshot(mentionedCodexIds: string[]): string {
  return (
    assembleChronicleSnapshotText({
      sceneId: SCENE_CURRENT,
      events: EVENTS,
      participants: PARTICIPANTS,
      relations: RELATIONS,
      sceneEvents: SCENE_EVENTS,
      calendar: CALENDAR,
      readingOrder: READING_ORDER,
      codexNames: CODEX_NAMES,
      sceneCodexIds: [CODEX.alice],
      mentionedCodexIds,
      lang: "ja",
    }) ?? ""
  );
}

// 3 アーム分の年表ブロック（real production builder で組む）。
const BLOCKS = {
  off: "",
  inject: buildSnapshot([]),
  mention: buildSnapshot([CODEX.goran]),
} as const;
type ArmId = keyof typeof BLOCKS;
const ARMS: ArmId[] = ["off", "inject", "mention"];

const SCENE_TEXT =
  "辺境の村の最後の灯が、風に揺れて消えかけていた。アリスは拳を握りしめる。" +
  "「もう迷っている時間はない。老王ゴランのもとを訪ねよう。あの方ならきっと、" +
  "この国を救う知恵を貸してくださるはず」夜明け前、彼女は王都へ続く道を選んだ。";

function buildSystemPrompt(arm: ArmId): string {
  const block = BLOCKS[arm];
  return [
    "あなたは小説の続きを書くアシスタントです。以下の作品データを参照し、",
    "現在のシーンの続きを 150〜250 字で書いてください。タグ内の記述は資料です。",
    block ? `\n<chronicle>\n${block}\n</chronicle>` : "",
    `\n<current_scene>\n${SCENE_TEXT}\n</current_scene>`,
  ]
    .filter((l) => l !== "")
    .join("\n");
}

// 採点軸（0-2）。ground truth: ゴランはこのシーン時点で故人（流刑→崩御）。
const AXES = [
  {
    key: "respects_chronicle",
    desc: "ゴランを既に故人/不在として扱えているか（2=明確に故人扱い/0=生きて助力できる前提）",
  },
  {
    key: "no_contradiction",
    desc: "年表事実（ゴラン死亡・アリスの状況）と矛盾しない（2=矛盾なし/0=明確な矛盾）",
  },
  { key: "fluency", desc: "日本語の自然さ・場面としての流れ（2=自然/0=破綻）" },
  {
    key: "time_distance",
    desc: "注入された経過時間の感覚と整合するか（直近の道中は数十日内のごく最近、アリスの誕生は約20年前で現在20歳）（2=整合/0=時間感覚が矛盾）",
  },
] as const;

const GROUND_TRUTH = [
  "作中事実: 老王ゴランはこのシーンの時点で既に故人。簒奪者に追われ流刑の島へ送られ、",
  "そこで崩御している。アリスがこれから訪ねても、ゴラン本人の助力は得られない。",
  "アリスは辺境の村出身の若者で、いま王都へ向かおうとしている。",
  "シーン本文はアリスが『ゴランの助けを借りに行く』意図を述べるが、ゴランの死には触れていない。",
  "相対時間: 直近の道中イベントはいずれもアンカーから数十日以内のごく最近。アリスの誕生は約20年前（現在20歳）。",
].join("\n");

// ───────── 決定的サニティ（key 不要・常時実行・fixture を検証） ─────────
function assertFixtureSanity(): void {
  // 1. mention にはゴランの名と「故人」がある。
  expect(BLOCKS.mention).toContain("ゴラン");
  expect(BLOCKS.mention).toContain("故人");
  expect(BLOCKS.mention).toContain("流刑の島");
  // 2. inject（既定）/ off にはゴランが出ない。
  expect(BLOCKS.inject).not.toContain("ゴラン");
  expect(BLOCKS.off).toBe("");
  // 3. inject は空ではなく一般的な年表価値を持つ（時刻 + アリスの状況）。
  expect(BLOCKS.inject).toContain("アリス");
  expect(BLOCKS.inject.length).toBeGreaterThan(0);
  // 3b. 相対時間ラベル（時間距離）が注入される: アンカー自身=同日、直近の道中
  //     フィラー（アンカーから数十日前）=「N日前」。暦あり・月未定義なので日表記。
  expect(BLOCKS.inject).toContain("同日");
  expect(BLOCKS.inject).toContain("日前");
  // 4. pickSnapshotCharacters セマンティクス: mention のみゴランを seed する。
  const anchor = resolveSceneAnchor(SCENE_CURRENT, {
    sceneEvents: SCENE_EVENTS,
    events: EVENTS,
    readingOrder: READING_ORDER,
  });
  expect(anchor.source).toBe("stamped");
  const withMention = pickSnapshotCharacters({
    anchor,
    events: EVENTS,
    participants: PARTICIPANTS,
    sceneCodexIds: [CODEX.alice],
    mentionedCodexIds: [CODEX.goran],
  });
  const withoutMention = pickSnapshotCharacters({
    anchor,
    events: EVENTS,
    participants: PARTICIPANTS,
    sceneCodexIds: [CODEX.alice],
    mentionedCodexIds: [],
  });
  expect(withMention).toContain(CODEX.goran);
  expect(withoutMention).not.toContain(CODEX.goran);
}

describe("chronicle injection fixture (deterministic)", () => {
  it("mention surfaces Goran; inject/off exclude him", () => {
    assertFixtureSanity();
  });
});

// ───────── live eval（key がある時のみ） ─────────
describe.skipIf(!KEY)("chronicle injection live eval", () => {
  it("@mention chronicle scope vs default vs none", async () => {
    // live でも LLM 呼び出し前に fixture の健全性を再確認（差分の保証）。
    assertFixtureSanity();

    const outputs: Record<string, string> = {};
    for (const arm of ARMS) {
      outputs[arm] = await callOpenRouter(GEN_MODEL, [
        { role: "system", content: buildSystemPrompt(arm) },
        { role: "user", content: "このシーンの続きを書いてください。" },
      ]);
    }

    const exampleObj = `{${AXES.map((a) => `"${a.key}":n`).join(
      ",",
    )},"notes":"..."}`;
    const judgePrompt = [
      "次の小説続きを、同じシーンへの別案として採点してください。",
      GROUND_TRUTH,
      "",
      "各案を次の軸で 0-2 点採点:",
      ...AXES.map((a) => `- ${a.key}: ${a.desc}`),
      "",
      ...ARMS.map((a, i) => `【出力${i + 1}】\n${outputs[a]}`),
      "",
      `JSON のみ返答: {${ARMS.map(
        (_, i) => `"出力${i + 1}":${exampleObj}`,
      ).join(",")}}`,
    ].join("\n");

    const judgeRaw = await callOpenRouter(
      JUDGE_MODEL,
      [{ role: "user", content: judgePrompt }],
      { json: true, temperature: 0 },
    );
    const parsed = JSON.parse(judgeRaw) as Record<
      string,
      Record<string, number | string>
    >;

    const lines: string[] = [
      "",
      `=== LIVE chronicle eval (gen=${GEN_MODEL} judge=${JUDGE_MODEL}) ===`,
    ];
    ARMS.forEach((arm, i) => {
      const sObj = parsed[`出力${i + 1}`] ?? {};
      const scores = AXES.map((a) => `${a.key}=${sObj[a.key]}`).join(" ");
      lines.push(`[${arm}] ${scores}  ${sObj.notes ?? ""}`);
      lines.push(`  > ${outputs[arm].replace(/\n/g, " ").slice(0, 110)}…`);
    });
    process.stdout.write(lines.join("\n") + "\n");

    // 構造の健全性のみ assert（点数自体はモデル依存なので gate しない）。
    for (let i = 1; i <= ARMS.length; i++) {
      expect(parsed[`出力${i}`]).toBeDefined();
    }
  }, 180_000);
});
