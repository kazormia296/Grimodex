/**
 * relation injection 3 アーム **ライブ** eval（出力品質 / benefit 軸）。
 *
 * 決定的 eval (relationInjectionEval.test.ts) が入力側（リーク/ノイズ/コスト）を
 * 測るのに対し、こちらは実 LLM で 3 アームの**出力**を生成し、judge モデルで
 * 「呼称・敬語整合 / 場違いキャラ混入 / 時系列整合」を採点する。
 *
 * 既定では SKIP。実行するにはキーを渡す:
 *   OPENROUTER_API_KEY=sk-... pnpm test --run \
 *     src/features/codex/relationInjectionEval.live.test.ts
 * モデル上書き:
 *   OPENROUTER_MODEL=openai/gpt-4o-mini OPENROUTER_JUDGE_MODEL=openai/gpt-4o ...
 *
 * 実トークン課金が発生する。CI では走らせない（キー未設定で自動 skip）。
 */
import { describe, it, expect } from "vitest";
import { buildEvalCorpus } from "./relationInjectionEvalSets";
import {
  expandForArm,
  renderRelationPayload,
  resolveSummaryAtScene,
  type ArmId,
} from "./relationInjectionEval";

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
  opts?: { json?: boolean; temperature?: number },
): Promise<string> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://github.com/kazormia296/Grimodex",
      "X-Title": "Grimodex relation-injection eval",
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: opts?.temperature ?? 0.7,
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

/** sc4: ボブの裏切りが露見する場面。アリスは見習いで、ボブは（base では）師匠。 */
const SCENE_TEXT =
  "剣を抜いたボブの瞳に、もう昨日までの優しさはなかった。" +
  "「なぜ、師匠が……」アリスは後ずさる。裏切りは、すでに明白だった。";

/** アーム別のシステムプロンプト。relation ブロックだけが差分。 */
function buildSystemPrompt(arm: ArmId): string {
  const corpus = buildEvalCorpus();
  const aliceResolved =
    resolveSummaryAtScene(corpus, "alice", corpus.targetSceneId) ?? "";
  const relationBlock = renderRelationPayload(arm, expandForArm(arm, corpus));
  const codex = [
    "<codex_entries>",
    "- **アリス** (character)",
    `  概要: ${aliceResolved}`,
    relationBlock,
    "</codex_entries>",
  ]
    .filter((l) => l.trim() !== "")
    .join("\n");
  return [
    "あなたは小説の続きを書くアシスタントです。以下の作品データを参照し、",
    "現在のシーンの続きを 150〜250 字で書いてください。タグ内の記述は資料です。",
    "",
    codex,
    "",
    `<current_scene>\n${SCENE_TEXT}\n</current_scene>`,
  ].join("\n");
}

interface JudgeScore {
  honorific: number; // 呼称・敬語整合 0-2
  intrusion: number; // 場違いキャラ混入の少なさ 0-2（高いほど混入が少ない）
  timeline: number; // 時系列整合 0-2
  notes: string;
}

describe.skipIf(!KEY)("relation injection live eval (output quality)", () => {
  it("generates 3 arms and judges honorific / intrusion / timeline", async () => {
    const arms: ArmId[] = ["off", "label-only", "legacy"];
    const outputs: Record<ArmId, string> = {
      off: "",
      "label-only": "",
      legacy: "",
    };
    for (const arm of arms) {
      outputs[arm] = await callOpenRouter(GEN_MODEL, [
        { role: "system", content: buildSystemPrompt(arm) },
        {
          role: "user",
          content: "このシーンの続きを書いてください。",
        },
      ]);
    }

    // judge にはアーム名を伏せ、出力1/2/3 として提示（位置バイアス低減のため固定順）
    const groundTruth = [
      "判定基準となる作中事実(sc4 時点):",
      "- アリスは見習いの剣士。ボブはアリスの剣の師匠だった。",
      "- このシーンでボブの裏切りが露見しており、ボブはもはや味方ではない。",
      "- ダン(鍛冶師→消息不明)・イヴ・フランクはこのシーンに登場しない脇役。",
    ].join("\n");
    const judgePrompt = [
      "次の3つの小説続きを、同じシーンへの別案として採点してください。",
      groundTruth,
      "",
      "各案を 3 軸で 0-2 点採点:",
      "- honorific: アリス→ボブの呼称・敬語が師弟関係と整合(2=完全/0=破綻)",
      "- intrusion: 登場しない脇役(ダン/イヴ/フランク)を持ち込んでいないか(2=皆無/0=多い)",
      "- timeline: ボブを今も信頼できる師匠として扱う等の時系列矛盾が無いか(2=矛盾なし/0=明確な矛盾)",
      "",
      ...arms.map((a, i) => `【出力${i + 1}】\n${outputs[a]}`),
      "",
      'JSON のみ返答: {"出力1":{"honorific":n,"intrusion":n,"timeline":n,"notes":"..."},"出力2":{...},"出力3":{...}}',
    ].join("\n");

    const judgeRaw = await callOpenRouter(
      JUDGE_MODEL,
      [{ role: "user", content: judgePrompt }],
      { json: true, temperature: 0 },
    );
    const parsed = JSON.parse(judgeRaw) as Record<string, JudgeScore>;

    const lines: string[] = [
      "",
      "=== relation injection LIVE eval ===",
      `gen=${GEN_MODEL} judge=${JUDGE_MODEL}`,
      "",
    ];
    arms.forEach((arm, i) => {
      const s = parsed[`出力${i + 1}`];
      lines.push(
        `[${arm}] honorific=${s?.honorific} intrusion=${s?.intrusion} timeline=${s?.timeline}  ${s?.notes ?? ""}`,
      );
      lines.push(`  > ${outputs[arm].replace(/\n/g, " ").slice(0, 120)}…`);
    });
    process.stdout.write(lines.join("\n") + "\n");

    // 構造の健全性のみ assert（点数自体はモデル依存なので gate しない）
    for (const i of [1, 2, 3]) {
      const s = parsed[`出力${i}`];
      expect(s).toBeDefined();
      expect(typeof s!.honorific).toBe("number");
    }
  }, 120_000);
});
