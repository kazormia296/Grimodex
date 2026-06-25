/**
 * 単発（tool 無し）AI サーフェスの **ライブ** E2E（実 LLM）。
 *
 * 各サーフェスについて、**本番のプロンプトビルダーと本番のパーサ**を import して
 * 使い（再構築によるドリフトを避ける）、{@link runLiveSingleShot} で実モデルに
 * 1 往復投げ、出力が本番の契約（非空 / JSON 形 / enum）を満たすことを検証する。
 *
 * 既定 SKIP。実行（実トークン課金あり）:
 *   OPENROUTER_API_KEY=sk-... pnpm test --run \
 *     src/features/ai-verification/singleShot.live.test.ts
 *   モデル上書き: OPENROUTER_MODEL（既定 openai/gpt-4o-mini）。
 *
 * 検証範囲の境界: ここで検証するのは「本番プロンプト × 実モデル応答 × 本番パーサ」の
 * 挙動。本番の Tauri→Rust トランスポート（provider routing / prompt cache /
 * streaming イベント / usage 台帳）は範囲外（docs/AI経路検証.md 参照）。
 */
import { describe, it, expect, vi } from "vitest";

// 本ファイルは aiLiveHarness 経由で agentLoop→contextBuilder を読み込むため、
// tokenizer の WASM ロードを避ける（agentToolCall.live.test.ts と同じ）。
vi.mock("@/features/chat/contextBuilder", () => ({
  ensureTokenizer: vi.fn(async () => {}),
  countTokens: (s: string) => (s ? s.length : 0),
}));

import { getPromptCatalog } from "@/prompts/index";
import { extractJsonObject } from "@/prompts/shared/jsonContract";
import {
  liveApiKey,
  liveModel,
  runLiveSingleShot,
} from "@/features/chat/agent/aiLiveHarness";
import { safeParseAiEvaluation } from "@/features/foreshadow/types";
import {
  buildSystemPrompt as buildMapSystemPrompt,
  buildUserPrompt as buildMapUserPrompt,
  parseCards,
} from "@/features/map/mapAiApi";
import {
  buildSystemPrompt as buildTreeSystemPrompt,
  buildUserPrompt as buildTreeUserPrompt,
  parseTreePlan,
  type GenerateTreePlanInput,
} from "@/features/tree/aiScaffold/generate";
import {
  buildSystemPrompt as buildInlineSystemPrompt,
  buildUserPrompt as buildInlineUserPrompt,
} from "@/features/editor/inlineAi/inlineAiApi";
import { getInlineAiCommands } from "@/features/editor/inlineAi/inlineAiCommands";
import type { InlineAiContext } from "@/features/editor/inlineAi/inlineAiTypes";
import type { ChatMessage } from "@/features/chat/chatTypes";
import type { RoleInferenceInput } from "@/features/editor/beat/inferMentionRoles";
import { meanPairwiseDistinctness } from "@/lib/textDiversity";

const KEY = liveApiKey();
const LIVE_TIMEOUT = 120_000;
const cat = getPromptCatalog("ja");

function mkMsg(role: "user" | "assistant", content: string): ChatMessage {
  return {
    id: `m-${role}`,
    sessionId: "s-test",
    role,
    content,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

describe.skipIf(!KEY)(
  `single-shot AI surfaces live E2E (${liveModel()})`,
  () => {
    it(
      "synopsis: 本番ビルダーで非空のあらすじを生成",
      async () => {
        const prompt = cat.chatApi.buildSynopsisFromContentPrompt(
          "再会",
          "朱音は古書店で蓮と再会した。蓮は今度の剣道の大会の話を切り出し、朱音は懐かしさと少しの照れを感じた。",
        );
        const { text } = await runLiveSingleShot(prompt);
        console.log("synopsis:", text.slice(0, 120));
        expect(text.trim().length).toBeGreaterThan(0);
      },
      LIVE_TIMEOUT,
    );

    it(
      "session_title: 本番ビルダーで短いタイトルを生成",
      async () => {
        const prompt = cat.chatApi.buildSessionTitlePrompt(
          "剣道大会のシーンを書きたい",
          "では、朱音と蓮の会話から始めましょう。",
        );
        const { text } = await runLiveSingleShot(prompt);
        console.log("title:", text.slice(0, 80));
        expect(text.trim().length).toBeGreaterThan(0);
      },
      LIVE_TIMEOUT,
    );

    it(
      "summarization: 本番ビルダー(実 ChatMessage[])で引き継ぎ要約を生成",
      async () => {
        const msgs: ChatMessage[] = [
          mkMsg("user", "主人公・朱音の設定を相談したい。"),
          mkMsg(
            "assistant",
            "朱音は16歳、古書店でアルバイト。蓮とは幼馴染、という設定でどうでしょう。",
          ),
        ];
        const prompt = cat.summarization.buildPrompt(msgs, { generation: 1 });
        const { text } = await runLiveSingleShot(prompt);
        console.log("summary:", text.slice(0, 120));
        expect(text.trim().length).toBeGreaterThan(0);
      },
      LIVE_TIMEOUT,
    );

    it(
      "foreshadow.auditChapter: 本番ビルダー+extractJsonObject で candidates 配列",
      async () => {
        const prompt = cat.foreshadow.buildAuditChapterPrompt({
          existingList: "(なし)",
          codexList: "- 朱音 (character): 主人公。古書店でバイトする16歳。",
          sceneTexts:
            "[scene-1] 朱音は棚の奥で古い真鍮の鍵を見つけた。なぜか胸騒ぎがして、誰にも言わずポケットにしまった。",
        });
        const { text } = await runLiveSingleShot(prompt);
        const json = extractJsonObject(text);
        expect(json, `JSON 抽出失敗: ${text.slice(0, 150)}`).not.toBeNull();
        const parsed = JSON.parse(json as string) as { candidates?: unknown };
        expect(Array.isArray(parsed.candidates)).toBe(true);
      },
      LIVE_TIMEOUT,
    );

    it(
      "plot_thread_propose: 本番ビルダー+extractJsonObject で threads 配列",
      async () => {
        const prompt = cat.plotThread.buildProposePlotThreadsPrompt({
          existingList: "(なし)",
          sceneTexts:
            "--- sceneId=scene-1, title=出会い, order=0 ---\n朱音は古書店で蓮と再会し、剣道の大会の話を聞いた。\n\n" +
            "--- sceneId=scene-2, title=決意, order=1 ---\n蓮は大会に向けて朱音に応援を頼み、朱音は支えると約束した。",
        });
        const { text } = await runLiveSingleShot(prompt);
        const json = extractJsonObject(text);
        expect(json, `JSON 抽出失敗: ${text.slice(0, 150)}`).not.toBeNull();
        const parsed = JSON.parse(json as string) as { threads?: unknown };
        expect(Array.isArray(parsed.threads)).toBe(true);
      },
      LIVE_TIMEOUT,
    );

    it(
      "foreshadow.proposePastSetups: 本番ビルダー+extractJsonObject で candidates 配列",
      async () => {
        const prompt = cat.foreshadow.buildProposePastSetupsPrompt({
          intent:
            "朱音が拾った鍵が、終盤で母の遺した文箱を開ける鍵だと判明する",
          payoffSceneId: "scene-10",
          payoffExcerpt:
            "鍵は文箱の錠にぴたりと合った。母の字で名が刻まれていた。",
          sceneSummary:
            "[scene-1] 古書店で鍵を拾う\n[scene-2] 帰り道で蓮と話す",
          codexSummary: "- 朱音 (character): 主人公",
        });
        const { text } = await runLiveSingleShot(prompt);
        const json = extractJsonObject(text);
        expect(json, `JSON 抽出失敗: ${text.slice(0, 150)}`).not.toBeNull();
        const parsed = JSON.parse(json as string) as { candidates?: unknown };
        expect(Array.isArray(parsed.candidates)).toBe(true);
      },
      LIVE_TIMEOUT,
    );

    it(
      "foreshadow.evaluateSetupStrength: 本番ビルダー+safeParseAiEvaluation で3ペルソナ",
      async () => {
        const prompt = cat.foreshadow.buildEvaluateSetupStrengthPrompt({
          foreshadowIntent: "鍵が終盤の文箱に対応することの伏線",
          setupExcerpt:
            "朱音は古い鍵を見つけ、なぜか捨てられずポケットにしまった。",
        });
        const { text } = await runLiveSingleShot(prompt);
        const json = extractJsonObject(text);
        const evald = safeParseAiEvaluation(json);
        expect(evald, `評価 parse 失敗: ${text.slice(0, 150)}`).not.toBeNull();
        expect(["subtle", "moderate", "overt"]).toContain(
          evald!.careful.strength,
        );
        expect(evald!.casual.reasoning.length).toBeGreaterThan(0);
      },
      LIVE_TIMEOUT,
    );

    it(
      "beat_role: 本番ビルダー+extractJsonObject で role を推論",
      async () => {
        const input: RoleInferenceInput = {
          beatInstructions: "朱音が蓮に鍵のことを打ち明ける",
          generatedProse:
            "朱音は意を決して蓮に鍵を見せた。蓮はそれを手に取り、じっと見つめた。",
          mentions: [
            { codexId: "char-akane", name: "朱音", currentRole: "mentioned" },
            { codexId: "char-ren", name: "蓮", currentRole: "mentioned" },
          ],
        };
        const prompt = cat.inferMentionRoles.buildPrompt(input);
        const { text } = await runLiveSingleShot(prompt);
        const json = extractJsonObject(text);
        expect(json, `JSON 抽出失敗: ${text.slice(0, 150)}`).not.toBeNull();
        const parsed = JSON.parse(json as string) as {
          results?: Array<{ codexId?: unknown; role?: unknown }>;
        };
        expect(Array.isArray(parsed.results)).toBe(true);
        for (const r of parsed.results ?? []) {
          expect(["actor", "target", "mentioned"]).toContain(r.role);
        }
      },
      LIVE_TIMEOUT,
    );

    it(
      "map_branch: 本番ビルダー+parseCards で doc カードを生成",
      async () => {
        const system = buildMapSystemPrompt(
          { title: "鍵の物語", language: "ja" },
          [],
        );
        const user = buildMapUserPrompt(
          "朱音が鍵の謎を追っていく展開のアイデア",
          3,
          [],
          "ja",
        );
        const { text } = await runLiveSingleShot(user, { system });
        const cards = parseCards(text, 3, "ja");
        expect(cards.length).toBe(3);
        for (const c of cards) {
          const doc = JSON.parse(c.body) as { type?: string };
          expect(doc.type).toBe("doc");
        }
        // 少なくとも 1 枚はモデルが実際に生成した（pad タイトルではない）。
        expect(cards.some((c) => !/^アイデア \d+$/.test(c.title))).toBe(true);
      },
      LIVE_TIMEOUT,
    );

    it(
      "map_branch VS: VS-on は VS-off より案が多様(構造=LLM盲検判定・語彙=補助)",
      async () => {
        // mode collapse が出やすい手垢のついたテーマで VS の効果を測る。
        const THEMES = [
          "無人駅をめぐる物語",
          "幼馴染と再会する物語",
          "勇者が魔王を討つ物語",
          "学園で起きる青春の物語",
        ];
        // 本番 cloud 相当: CoT 有効 + 確率添付(parseCards で除去)。
        const vsOpts = { threshold: 0.05, cot: true, emitProbability: true };

        const gen = async (theme: string, on: boolean) => {
          const system = buildMapSystemPrompt(
            { title: "アイデア出し", language: "ja" },
            [],
            on ? vsOpts : null,
          );
          const user = buildMapUserPrompt(theme, 5, [], "ja", on);
          const { text } = await runLiveSingleShot(user, { system });
          return parseCards(text, 5, "ja", on);
        };

        const toTexts = (cards: { title: string; body: string }[]): string[] =>
          cards.map((c) => {
            const doc = JSON.parse(c.body) as {
              content?: Array<{ content?: Array<{ text?: string }> }>;
            };
            const body = (doc.content ?? [])
              .flatMap((n) => (n.content ?? []).map((t) => t.text ?? ""))
              .join(" ");
            return `${c.title} ${body}`;
          });

        // 構造多様性は語彙では捉えにくい(日本語は共通語彙が多い=Artificial
        // Hivemind)。盲検 A/B で「設定・構造・発想の多様さ」を LLM に判定させる。
        const judge = async (
          theme: string,
          set1: string[],
          set2: string[],
        ): Promise<"1" | "2" | "tie"> => {
          const system =
            "あなたは創作の評価者です。2 つのアイデア集合を比べ、設定・物語構造・発想の多様さ(互いに似通っていないか)を判定してください。語彙や言い回しの差ではなく、前提・構造の多様性だけを見ること。";
          const user = `テーマ: ${theme}\n\n# 集合1\n${set1.join("\n")}\n\n# 集合2\n${set2.join("\n")}\n\nより多様なのはどちらですか。1 行目に "1" "2" "TIE" のいずれかだけ、2 行目に理由を 1 文。`;
          const { text } = await runLiveSingleShot(user, { system });
          const head = text
            .trim()
            .replace(/^[^0-9A-Za-z]*/, "")
            .toUpperCase();
          if (head.startsWith("1")) return "1";
          if (head.startsWith("2")) return "2";
          return "tie";
        };

        let offLexSum = 0;
        let onLexSum = 0;
        let onWins = 0;
        let offWins = 0;
        let ties = 0;
        const rows: string[] = [];

        await Promise.all(
          THEMES.map(async (theme, i) => {
            const [off, on] = await Promise.all([
              gen(theme, false),
              gen(theme, true),
            ]);
            const dOff = meanPairwiseDistinctness(toTexts(off));
            const dOn = meanPairwiseDistinctness(toTexts(on));
            offLexSum += dOff;
            onLexSum += dOn;

            // 位置バイアス打ち消し: 奇数テーマは on を「集合1」に置く。
            const onIsFirst = i % 2 === 1;
            const verdict = await judge(
              theme,
              onIsFirst ? toTexts(on) : toTexts(off),
              onIsFirst ? toTexts(off) : toTexts(on),
            );
            let winner: "on" | "off" | "tie";
            if (verdict === "tie") winner = "tie";
            else winner = (verdict === "1") === onIsFirst ? "on" : "off";
            if (winner === "on") onWins++;
            else if (winner === "off") offWins++;
            else ties++;

            rows.push(
              `theme="${theme}" lexOff=${dOff.toFixed(3)} lexOn=${dOn.toFixed(3)} judge=${winner}`,
            );
          }),
        );

        const offLex = offLexSum / THEMES.length;
        const onLex = onLexSum / THEMES.length;
        const summary = `[VS] lexical off=${offLex.toFixed(3)} on=${onLex.toFixed(3)} | judge on:${onWins} off:${offWins} tie:${ties}`;
        rows.push(summary);

        console.log(summary);
        // vitest は console.log を抑制するため、解析用に env でファイルダンプ可能に
        // する(既定 no-op)。VS_METRICS_OUT=/path pnpm test ... で有効。
        if (process.env.VS_METRICS_OUT) {
          (await import("node:fs")).writeFileSync(
            process.env.VS_METRICS_OUT,
            rows.join("\n") + "\n",
          );
        }

        // 語彙は構造を捉えないため壊滅的回帰のみ gate(緩い下限)。
        expect(onLex).toBeGreaterThanOrEqual(offLex * 0.85);
        // 主シグナル: 構造的多様性で VS-on が VS-off に勝ち越す or 互角
        // (モデルのゆらぎがあるため鍵を渡したときのみ実行する確率的 gate)。
        expect(onWins).toBeGreaterThanOrEqual(offWins);
      },
      LIVE_TIMEOUT,
    );

    it(
      "tree_scaffold: 本番ビルダー+parseTreePlan で create ops を生成",
      async () => {
        const input: GenerateTreePlanInput = {
          kind: "scaffold",
          instruction:
            "第1章として、朱音が鍵を見つけてから蓮に相談するまでを3シーンで構成して",
          withSynopsis: false,
          outline: [],
          rootRef: null,
          project: { title: "鍵の物語", language: "ja" },
        };
        const system = buildTreeSystemPrompt(input);
        const user = buildTreeUserPrompt(input);
        const { text } = await runLiveSingleShot(user, { system });
        const plan = parseTreePlan(text, "scaffold");
        expect(plan.kind).toBe("scaffold");
        expect(Array.isArray(plan.ops)).toBe(true);
        expect(plan.ops.length).toBeGreaterThan(0);
        // scaffold は create のみ（move/rename を出さない）。
        for (const op of plan.ops) {
          expect(op.op).toBe("create");
        }
      },
      LIVE_TIMEOUT,
    );

    // ── inline AI 補完の出力プロンプト QA ────────────────────────────────────
    // EditorPane と リニア (LinearSceneBlock/useLinearInlineAi) が共有する本番
    // ビルダー inlineAiApi.buildSystemPrompt/buildUserPrompt (= getPromptCatalog().
    // inlineAi) を実 InlineAiContext で組み、実モデル出力を QA する。リクエスト
    // 挙動は別 it ("streaming surfaces:") が、ここでは出力プロンプトの品質を見る。
    it(
      "inline_ai_output: continue は文脈の続きを生成する",
      async () => {
        const continueCmd = getInlineAiCommands().find(
          (c) => c.id === "continue",
        )!;
        const ctx: InlineAiContext = {
          projectTitle: "鋼の戴冠",
          sceneTitle: "古書店の密談",
          sceneText:
            "朱音は埃をかぶった棚から革表紙の本を抜き取った。頁を開くと、見覚えのある筆跡が並んでいた。",
          codexSummaries:
            "- 朱音: 古書に触れると書き手の記憶を読む力を持つ少女。",
          cursorContext:
            "頁を開くと、見覚えのある筆跡が並んでいた。【カーソル】",
          customInstruction: "",
        };
        const { text } = await runLiveSingleShot(
          buildInlineUserPrompt(continueCmd, ctx, "ja"),
          { system: buildInlineSystemPrompt(continueCmd, ctx, "ja") },
        );
        console.log("inline_ai_output continue:", text.slice(0, 160));
        expect(text.trim().length).toBeGreaterThan(0);
      },
      LIVE_TIMEOUT,
    );

    it(
      "inline_ai_output: rewrite は選択文を別表現へ書き換える",
      async () => {
        const rewriteCmd = getInlineAiCommands().find(
          (c) => c.id === "rewrite",
        )!;
        const selected = "彼は走った。";
        const ctx: InlineAiContext = {
          projectTitle: "鋼の戴冠",
          sceneTitle: "追跡",
          sceneText: `路地裏に銃声が響いた。${selected}息が上がり、視界が滲む。`,
          codexSummaries: "",
          selectedText: selected,
          customInstruction: "",
        };
        const { text } = await runLiveSingleShot(
          buildInlineUserPrompt(rewriteCmd, ctx, "ja"),
          { system: buildInlineSystemPrompt(rewriteCmd, ctx, "ja") },
        );
        console.log("inline_ai_output rewrite:", text.slice(0, 160));
        const out = text.trim();
        expect(out.length).toBeGreaterThan(0);
        // 書き換えなので入力選択文そのままではない。
        expect(out).not.toBe(selected);
      },
      LIVE_TIMEOUT,
    );

    it(
      "streaming surfaces: 下層の OpenRouter リクエストが応答を返す",
      async () => {
        // chat:stream-* / inline-ai:stream-* の配信は Rust/Tauri IPC の責務で
        // OpenRouter ハーネスでは非再現。ここでは「同じ送信内容で実モデルが応答
        // する」というリクエスト挙動のみ検証する（配信境界は docs 参照）。
        const { text } = await runLiveSingleShot(
          "朱音と蓮が古書店で交わす短い会話を一往復だけ書いてください。",
          { system: "あなたは小説執筆を助けるアシスタントです。" },
        );
        expect(text.trim().length).toBeGreaterThan(0);
      },
      LIVE_TIMEOUT,
    );
  },
);
