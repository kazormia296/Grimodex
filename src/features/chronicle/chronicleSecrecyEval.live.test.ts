/**
 * 作中年表 AI 秘匿（reveal アンカー方式）の **ライブ** eval。
 *
 * chronicleInjectionEval.live.test.ts と同型。3 アームの差分は「同じ秘匿イベントが
 * 現在シーンの読む順位置によって注入されるか否か」だけ:
 *   - off         : 年表ブロック無し。
 *   - secretHidden: reveal シーンより**前**を書く（secret イベントは隠れる）。
 *   - pastReveal  : reveal シーン**以降**を書く（secret イベントが開示される）。
 *
 * 検証する不変条件（= reveal アンカー方式の核心）:
 *   秘匿イベント「宰相バルドが先王を毒殺した」は、secretHidden の年表ブロックに
 *   現れず、pastReveal の年表ブロックには現れる。これを実プロダクション builder
 *   （assembleChronicleSnapshotText）で組んだブロックに対して決定的に assert する
 *   （key 不要・常時実行）。LLM アームはその下流効果（hidden 時は AI がネタバレを
 *   書けない）を示す。
 *
 * 既定では live 部分は SKIP。実行するにはキーを渡す:
 *   OPENROUTER_API_KEY=sk-... pnpm test --run \
 *     src/features/chronicle/chronicleSecrecyEval.live.test.ts
 * モデル上書き: OPENROUTER_MODEL / OPENROUTER_JUDGE_MODEL。実トークン課金あり。
 */
import { describe, it, expect } from "vitest";
import { assembleChronicleSnapshotText } from "./chronicleSnapshot";
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
      "X-Title": "Grimodex chronicle-secrecy eval",
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
// 主人公アリスが宰相バルドに謁見する。裏設定: バルドは先王を毒殺した張本人で、
// それは物語の終盤シーン（scene-reveal）で初めて明かされる。毒殺イベントは
// secret=true・revealSceneId=scene-reveal。読む順では:
//   scene-early(0) < scene-reveal(1)
// scene-early を書く時は毒殺が隠れ、scene-reveal を書く時は開示される。

const PROJECT = "proj-secrecy-eval";
const CODEX = {
  alice: "codex-alice",
  bald: "codex-bald",
  king: "codex-king",
  palace: "codex-palace",
} as const;

const SCENE_EARLY = "scene-early";
const SCENE_REVEAL = "scene-reveal";

const CODEX_NAMES = new Map<string, string>([
  [CODEX.alice, "アリス"],
  [CODEX.bald, "バルド"],
  [CODEX.king, "先王"],
  [CODEX.palace, "王宮"],
]);

const CALENDAR: ChronicleCalendar = {
  daysPerYear: 360,
  seasonBoundaries: DEFAULT_SEASON_BOUNDARIES,
};

// ordinal は最古→最新。4 = 毒殺 + anchorEarly + anchorReveal + filler。
const ORD = generateNKeysBetween(null, null, 4);

function mkEvent(
  e: Partial<EventRow> & { id: string; ordinal: string; title: string },
): EventRow {
  return {
    id: e.id,
    projectId: PROJECT,
    title: e.title,
    note: e.note ?? null,
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
  poison: "ev-poison",
  anchorEarly: "ev-anchor-early",
  anchorReveal: "ev-anchor-reveal",
} as const;

const EVENTS: EventRow[] = [
  // 裏設定の毒殺（fabula では最古・読む順では reveal で開示）。off-page（未 stamp）。
  mkEvent({
    id: EV.poison,
    ordinal: ORD[0]!,
    title: "宰相バルド、先王を毒殺する",
    note: "簒奪のため毒を盛った真相",
    primaryCodexId: CODEX.bald,
    locationCodexId: CODEX.palace,
    startTime: 0,
    kind: "generic",
    secret: true,
    revealSceneId: SCENE_REVEAL,
  }),
  // scene-early の stamped アンカー。
  mkEvent({
    id: EV.anchorEarly,
    ordinal: ORD[1]!,
    title: "アリス、王宮でバルドに謁見する",
    primaryCodexId: CODEX.alice,
    locationCodexId: CODEX.palace,
    startTime: 18000,
    kind: "generic",
  }),
  // scene-reveal の stamped アンカー（毒殺より後・開示時点）。
  mkEvent({
    id: EV.anchorReveal,
    ordinal: ORD[2]!,
    title: "アリス、古い侍医の日記を見つける",
    primaryCodexId: CODEX.alice,
    locationCodexId: CODEX.palace,
    startTime: 18500,
    kind: "generic",
  }),
];

const SCENE_EVENTS: SceneEventRow[] = [
  { sceneId: SCENE_EARLY, eventId: EV.anchorEarly },
  { sceneId: SCENE_REVEAL, eventId: EV.anchorReveal },
];

const PARTICIPANTS: ParticipantRow[] = [
  { eventId: EV.anchorEarly, codexEntryId: CODEX.alice, role: "視点" },
  { eventId: EV.anchorReveal, codexEntryId: CODEX.alice, role: "視点" },
];

const RELATIONS: EventRelationRow[] = [];

const READING_ORDER = new Map<string, number>([
  [SCENE_EARLY, 0],
  [SCENE_REVEAL, 1],
]);

function buildSnapshot(sceneId: string): string {
  return (
    assembleChronicleSnapshotText({
      sceneId,
      events: EVENTS,
      participants: PARTICIPANTS,
      relations: RELATIONS,
      sceneEvents: SCENE_EVENTS,
      calendar: CALENDAR,
      readingOrder: READING_ORDER,
      codexNames: CODEX_NAMES,
      sceneCodexIds: [CODEX.alice],
      lang: "ja",
    }) ?? ""
  );
}

const BLOCKS = {
  off: "",
  secretHidden: buildSnapshot(SCENE_EARLY),
  pastReveal: buildSnapshot(SCENE_REVEAL),
} as const;
type ArmId = keyof typeof BLOCKS;
const ARMS: ArmId[] = ["off", "secretHidden", "pastReveal"];

const SCENE_TEXT =
  "謁見の間で、宰相バルドはアリスへ穏やかな笑みを向けた。「ようこそ、勇者どの。" +
  "亡き先王陛下も、あなたのような若者の到来を待ち望んでおられた」アリスは礼を返す。" +
  "この王宮で、何を信じればよいのか――彼女にはまだ、何もわからなかった。";

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

// 採点軸（0-2）。leaks_secret は「低いほど良い」= 秘匿が守られている。
const AXES = [
  {
    key: "leaks_secret",
    desc: "バルドが先王を毒殺した／簒奪者だと述べ・強く示唆したか（2=明確に暴露/0=触れない）。低いほど秘匿が守られている。",
  },
  { key: "fluency", desc: "日本語の自然さ・場面としての流れ（2=自然/0=破綻）" },
] as const;

const GROUND_TRUTH = [
  "作中の裏設定: 宰相バルドは先王を毒殺した張本人だが、これは物語終盤まで読者に",
  "明かされない秘密である。現在シーンはアリスがバルドに初めて謁見する場面で、",
  "アリスも読者もこの真相をまだ知らない。続きが『バルドが毒殺犯だ』と明言・強く",
  "示唆すると、ネタバレ（伏線の早期露出）になる。",
].join("\n");

// ───────── 決定的サニティ（key 不要・常時実行・gate） ─────────
function assertFixtureSanity(): void {
  // pastReveal は毒殺の真相を含む（reveal 以降で開示）。
  expect(BLOCKS.pastReveal).toContain("毒殺");
  expect(BLOCKS.pastReveal).toContain("バルド");
  // secretHidden は毒殺の真相を含まない（reveal 前で秘匿）。
  expect(BLOCKS.secretHidden).not.toContain("毒殺");
  // off は空。
  expect(BLOCKS.off).toBe("");
  // secretHidden も空ではない（一般的な年表価値＝アリスの状況は出る）。
  expect(BLOCKS.secretHidden).toContain("アリス");
}

describe("chronicle secrecy fixture (deterministic)", () => {
  it("reveal シーン前は毒殺が隠れ、reveal シーン以降で開示される", () => {
    assertFixtureSanity();
  });
});

// ───────── live eval（key がある時のみ） ─────────
describe.skipIf(!KEY)("chronicle secrecy live eval", () => {
  it("off vs secret-hidden vs past-reveal", async () => {
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
      `=== LIVE chronicle secrecy eval (gen=${GEN_MODEL} judge=${JUDGE_MODEL}) ===`,
    ];
    ARMS.forEach((arm, i) => {
      const sObj = parsed[`出力${i + 1}`] ?? {};
      const scores = AXES.map((a) => `${a.key}=${sObj[a.key]}`).join(" ");
      lines.push(`[${arm}] ${scores}  ${sObj.notes ?? ""}`);
      lines.push(`  > ${outputs[arm].replace(/\n/g, " ").slice(0, 110)}…`);
    });
    process.stdout.write(lines.join("\n") + "\n");

    // 構造の健全性のみ assert（点数はモデル依存なので gate しない）。
    for (let i = 1; i <= ARMS.length; i++) {
      expect(parsed[`出力${i}`]).toBeDefined();
    }
  }, 180_000);
});
