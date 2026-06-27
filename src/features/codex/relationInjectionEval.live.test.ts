/**
 * relation injection **ライブ** eval（出力品質 / benefit 軸）。
 *
 * 決定的 eval (relationInjectionEval.test.ts) が入力側（リーク/ノイズ/コスト）を
 * 測るのに対し、こちらは実 LLM で各アームの**出力**を生成し、judge モデルで
 * シナリオ別の軸を採点する。2 シナリオ:
 *   1. betrayal: 関係がシーンに明記 → relation 注入の「コスト/害」を見る
 *                (off / label-only / legacy)
 *   2. benefit : 関係がシーン外にしか無い → relation 注入の「価値」を見る
 *                (off / label-only)
 *
 * 既定では SKIP。実行するにはキーを渡す:
 *   OPENROUTER_API_KEY=sk-... pnpm test --run \
 *     src/features/codex/relationInjectionEval.live.test.ts
 * モデル上書き: OPENROUTER_MODEL / OPENROUTER_JUDGE_MODEL。実トークン課金あり。
 */
import { describe, it, expect } from "vitest";
import {
  buildEvalCorpus,
  buildBenefitCorpus,
  buildIntraContextCorpus,
  buildIntraSymmetricCorpus,
  type RelationInjectionCorpus,
} from "./relationInjectionEvalSets";
import {
  expandForArm,
  renderRelationPayload,
  resolveSummaryAtScene,
  type ArmId,
} from "./relationInjectionEval";
import { collectIntraContextRelations } from "./relationExpansion";

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
      "X-Title": "Grimodex relation-injection eval",
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

/** アーム別システムプロンプト。relation ブロックだけが差分。 */
function buildSystemPrompt(
  corpus: RelationInjectionCorpus,
  sceneText: string,
  arm: ArmId,
): string {
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
    `<current_scene>\n${sceneText}\n</current_scene>`,
  ].join("\n");
}

/**
 * intra-context surfacing 用プロンプト。両端 seed (両方が文脈にいる) を full エントリ
 * (resolved 概要付き) として並べ、surface=true のときだけ各エントリに contextBuilder と
 * 同じ from/to via 規約で関係行を足す。production の collectIntraContextRelations を直に
 * 使うので、描画規約が本番とズレない (renderRelationPayload と同じ思想)。
 */
function buildIntraSystemPrompt(
  corpus: RelationInjectionCorpus,
  sceneText: string,
  surface: boolean,
): string {
  const edges = surface
    ? collectIntraContextRelations(
        corpus.seedEntryIds,
        corpus.relations,
        corpus.entries,
      )
    : [];
  // production (contextBuilder) と同じ role 明示表記: `{to}は{from}の{label}`。
  const viaByEntry = new Map<string, string[]>();
  for (const e of edges) {
    const line = `${e.toName}は${e.fromName}の${e.label}`;
    for (const id of [e.fromId, e.toId]) {
      const list = viaByEntry.get(id);
      if (list) list.push(line);
      else viaByEntry.set(id, [line]);
    }
  }
  const codexLines: string[] = ["<codex_entries>"];
  for (const seedId of corpus.seedEntryIds) {
    const entry = corpus.entries.find((x) => x.id === seedId);
    if (!entry) continue;
    const resolved =
      resolveSummaryAtScene(corpus, seedId, corpus.targetSceneId) ??
      entry.summary ??
      "";
    codexLines.push(`- **${entry.name}** (${entry.type})`);
    if (resolved) codexLines.push(`  概要: ${resolved}`);
    const via = viaByEntry.get(seedId);
    if (via && via.length > 0) codexLines.push(`  関係: ${via.join(" / ")}`);
  }
  codexLines.push("</codex_entries>");
  return [
    "あなたは小説の続きを書くアシスタントです。以下の作品データを参照し、",
    "現在のシーンの続きを 150〜250 字で書いてください。タグ内の記述は資料です。",
    "",
    codexLines.join("\n"),
    "",
    `<current_scene>\n${sceneText}\n</current_scene>`,
  ].join("\n");
}

interface Axis {
  key: string;
  desc: string;
}

interface Scenario {
  name: string;
  corpus: RelationInjectionCorpus;
  scene: string;
  arms: string[];
  /** アーム名 → システムプロンプト。discovery と intra-surfacing で描画が違うので注入。 */
  promptFor: (
    corpus: RelationInjectionCorpus,
    scene: string,
    arm: string,
  ) => string;
  groundTruth: string;
  axes: Axis[];
}

const SCENARIOS: Scenario[] = [
  {
    name: "betrayal (cost)",
    corpus: buildEvalCorpus(),
    scene:
      "剣を抜いたボブの瞳に、もう昨日までの優しさはなかった。" +
      "「なぜ、師匠が……」アリスは後ずさる。裏切りは、すでに明白だった。",
    arms: ["off", "label-only", "legacy"],
    promptFor: (c, sc, arm) => buildSystemPrompt(c, sc, arm as ArmId),
    groundTruth: [
      "作中事実(sc4): アリスは見習いの剣士、ボブは元・剣の師匠。",
      "このシーンでボブの裏切りが露見し、ボブはもはや味方ではない。",
      "ダン(鍛冶師→消息不明)・イヴ・フランクはこのシーンに登場しない脇役。",
    ].join("\n"),
    axes: [
      {
        key: "honorific",
        desc: "アリス→ボブの呼称・敬語が師弟関係と整合(2=完全/0=破綻)",
      },
      {
        key: "intrusion",
        desc: "登場しない脇役(ダン/イヴ/フランク)を持ち込んでいない(2=皆無/0=多い)",
      },
      {
        key: "timeline",
        desc: "ボブを今も信頼できる師匠として扱う等の時系列矛盾が無い(2=矛盾なし/0=明確な矛盾)",
      },
    ],
  },
  {
    name: "benefit (value)",
    corpus: buildBenefitCorpus(),
    scene:
      "二手に分かれた道の前で、アリスとボブは足を止めた。" +
      "右は安全だが遠回り、左は近いが危険。どちらへ進むか、いま決めねばならない。",
    arms: ["off", "label-only"],
    promptFor: (c, sc, arm) => buildSystemPrompt(c, sc, arm as ArmId),
    groundTruth: [
      "作中事実: ボブはアリスの従者(家臣)。アリスが主君で、ボブが仕える側。",
      "ただしこの主従関係はシーン本文には書かれていない。",
      "見た目の手がかりは逆(アリス=旅の若者 / ボブ=歴戦の騎士)なので、",
      "関係を知らなければ『アリスがボブに従う』と取り違えやすい。",
    ].join("\n"),
    axes: [
      {
        key: "direction",
        desc: "アリスが主・ボブが従者という主従の向きで描けている(2=正しい/0=逆転)",
      },
      {
        key: "register",
        desc: "敬語・呼称の向きが主従と整合(ボブがアリスを立てる)(2=整合/0=逆)",
      },
    ],
  },
  {
    // intra-surfacing: 両端とも文脈にいる 2 者の関係をラベルで明示する value 軸。
    // benefit との違いは bob も seed=full エントリ (概要付き) で並ぶこと。off は両者の
    // 概要だけ、surface は各エントリに向き付き関係行を足す。
    name: "intra-surface (value)",
    corpus: buildIntraContextCorpus(),
    scene:
      "分かれ道の前で、アリスとボブは馬を止めた。" +
      "右は安全だが遠回り、左は近いが危険。どちらへ進むか、いま決めねばならない。",
    arms: ["off", "surface"],
    promptFor: (c, sc, arm) => buildIntraSystemPrompt(c, sc, arm === "surface"),
    groundTruth: [
      "作中事実: ボブはアリスの家臣。アリスが主君で、ボブが仕える側。",
      "ただしこの主従関係はシーン本文にも各キャラの概要にも書かれていない。",
      "見た目の手がかりは逆(アリス=旅の若者 / ボブ=歴戦の騎士)なので、",
      "関係を知らなければ『歴戦の騎士ボブが若者アリスを率いる』と取り違えやすい。",
      "脇役は存在しない(このコーパスは alice/bob のみ)。",
    ].join("\n"),
    axes: [
      {
        key: "direction",
        desc: "アリスが主君・ボブが家臣という主従の向きで描けている(2=正しい/0=逆転)",
      },
      {
        key: "register",
        desc: "敬語・呼称の向きが主従と整合(ボブがアリスを立てる)(2=整合/0=逆)",
      },
    ],
  },
  {
    // intra-surfacing 対称版: 向きを当てる難所が無い純粋な value 測定。
    // 隠れた幼馴染関係を surfacing すると描写に反映されるかを見る。
    name: "intra-surface symmetric (value)",
    corpus: buildIntraSymmetricCorpus(),
    scene:
      "路地の出口で、警備隊長アリスと軽業師ボブは鉢合わせた。" +
      "追う者と追われる者として、二人の視線が正面からぶつかる。",
    arms: ["off", "surface"],
    promptFor: (c, sc, arm) => buildIntraSystemPrompt(c, sc, arm === "surface"),
    groundTruth: [
      "作中事実: アリスとボブは幼馴染(昔からの友)。",
      "ただしこの関係はシーン本文にも各キャラの概要にも書かれていない。",
      "表向きは警備隊長(アリス)と追われる軽業師(ボブ)で、",
      "関係を知らなければ赤の他人どうしの追跡劇として処理されやすい。",
      "脇役は存在しない(このコーパスは alice/bob のみ)。",
    ].join("\n"),
    axes: [
      {
        key: "relation",
        desc: "二人を幼馴染(旧知の友)として描けているか:名前呼び/見知った素振り/ためらい等(2=明確に反映/0=赤の他人扱い)",
      },
      {
        key: "consistency",
        desc: "各自の立場(隊長/軽業師)と追跡の状況に矛盾しない(2=整合/0=破綻)",
      },
    ],
  },
];

describe.skipIf(!KEY)("relation injection live eval", () => {
  it.each(SCENARIOS)(
    "scenario: $name",
    async (sc) => {
      const outputs: Record<string, string> = {};
      for (const arm of sc.arms) {
        outputs[arm] = await callOpenRouter(GEN_MODEL, [
          {
            role: "system",
            content: sc.promptFor(sc.corpus, sc.scene, arm),
          },
          { role: "user", content: "このシーンの続きを書いてください。" },
        ]);
      }

      const exampleObj = `{${sc.axes
        .map((a) => `"${a.key}":n`)
        .join(",")},"notes":"..."}`;
      const judgePrompt = [
        "次の小説続きを、同じシーンへの別案として採点してください。",
        sc.groundTruth,
        "",
        "各案を次の軸で 0-2 点採点:",
        ...sc.axes.map((a) => `- ${a.key}: ${a.desc}`),
        "",
        ...sc.arms.map((a, i) => `【出力${i + 1}】\n${outputs[a]}`),
        "",
        `JSON のみ返答: {${sc.arms
          .map((_, i) => `"出力${i + 1}":${exampleObj}`)
          .join(",")}}`,
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
        `=== LIVE eval / ${sc.name} (gen=${GEN_MODEL} judge=${JUDGE_MODEL}) ===`,
      ];
      sc.arms.forEach((arm, i) => {
        const s = parsed[`出力${i + 1}`] ?? {};
        const scores = sc.axes.map((a) => `${a.key}=${s[a.key]}`).join(" ");
        lines.push(`[${arm}] ${scores}  ${s.notes ?? ""}`);
        lines.push(`  > ${outputs[arm].replace(/\n/g, " ").slice(0, 110)}…`);
      });
      process.stdout.write(lines.join("\n") + "\n");

      // 構造の健全性のみ assert（点数自体はモデル依存なので gate しない）
      for (let i = 1; i <= sc.arms.length; i++) {
        expect(parsed[`出力${i}`]).toBeDefined();
      }
    },
    180_000,
  );
});
