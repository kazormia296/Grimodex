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
import type { ChatMessage } from "@/features/chat/chatTypes";
import type { RoleInferenceInput } from "@/features/editor/beat/inferMentionRoles";

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
