/**
 * 未確定固有名詞候補の LLM 判定 (B2) の **ライブ** 品質 E2E（実 LLM）。
 *
 * **本番のプロンプトビルダー (codexJudgment.buildCandidateJudgmentPrompt) と本番の
 * パーサ (parseJudgmentResponse) を import** して使い（再構築によるドリフトを避ける）、
 * {@link runLiveSingleShot} で実モデルに 1 往復投げ、判定品質を検証する:
 * - 構造: suggestedType は 4 種 enum / aliasOfId は実在 id か null。
 * - 意味: 明白な文脈の候補が正しく分類されるか（人物/場所/物）＋既存エントリの別名検出。
 *
 * 既定 SKIP。実行（実トークン課金あり）:
 *   OPENROUTER_API_KEY=sk-... pnpm test --run \
 *     src/features/codex/candidateJudgment.live.test.ts
 *   モデル上書き: OPENROUTER_MODEL（既定 openai/gpt-4o-mini）。
 *
 * 検証範囲: 「本番プロンプト × 実モデル応答 × 本番パーサ」。本番の Tauri→Rust
 * トランスポート (send_chat_message の provider routing / usage 台帳) は範囲外。
 */
import { describe, it, expect, vi } from "vitest";

// aiLiveHarness 経由で agentLoop→contextBuilder を読むため WASM tokenizer を避ける。
vi.mock("@/features/chat/contextBuilder", () => ({
  ensureTokenizer: vi.fn(async () => {}),
  countTokens: (s: string) => (s ? s.length : 0),
}));

import { getPromptCatalog } from "@/prompts/index";
import {
  liveApiKey,
  liveModel,
  runLiveSingleShot,
} from "@/features/chat/agent/aiLiveHarness";
import { parseJudgmentResponse } from "./candidateJudgment";
import { candidateKey } from "./codexCandidates";

const KEY = liveApiKey();
const LIVE_TIMEOUT = 120_000;
const cat = getPromptCatalog("ja");

// 明白な文脈の評価用フィクスチャ。人物/場所/物 と「既存エントリの別名」を1件ずつ。
const CANDIDATES = [
  {
    surface: "円明",
    lemma: "円明",
    count: 5,
    context: "円明は剣を抜き、敵に向かって駆け出した。",
  },
  {
    surface: "帝都アルカディア",
    lemma: "帝都アルカディア",
    count: 3,
    context: "一行は帝都アルカディアの城門をくぐった。",
  },
  {
    surface: "星辰剣",
    lemma: "星辰剣",
    count: 2,
    context: "彼は星辰剣を鞘から抜き放った。",
  },
  {
    surface: "田中",
    lemma: "田中",
    count: 2,
    context: "「田中、置いていくぞ」と隊長が呼びかけた。",
  },
];
const EXISTING = [{ id: "e-tanaka", name: "田中太郎", aliases: ["太郎"] }];

describe.skipIf(!KEY)(
  `codex candidate judgment live E2E (${liveModel()})`,
  () => {
    it(
      "本番プロンプト×実モデルで種別分類と別名検出が成立する",
      async () => {
        const prompt = cat.codexJudgment.buildCandidateJudgmentPrompt({
          candidates: CANDIDATES,
          existingEntries: EXISTING,
        });
        const validSurfaces = new Set(
          CANDIDATES.map((c) => candidateKey(c.surface)),
        );
        const knownIds = new Set(EXISTING.map((e) => e.id));

        const { text } = await runLiveSingleShot(prompt);
        const m = parseJudgmentResponse(text, validSurfaces, knownIds);

        // 評価可視化: 全候補の分類結果をログ出力 (人間が品質を見るため)。
        for (const c of CANDIDATES) {
          const j = m.get(candidateKey(c.surface));

          console.log(
            `[judge] ${c.surface} -> type=${j?.suggestedType ?? "(none)"} alias=${j?.aliasOfId ?? "-"} summary=${j?.summary ?? ""}`,
          );
        }

        // 構造: 返ってきた判定はすべて enum / 実在 id か null (パーサ契約)。
        for (const j of m.values()) {
          expect(["character", "location", "item", "lore"]).toContain(
            j.suggestedType,
          );
          expect(j.aliasOfId === null || knownIds.has(j.aliasOfId)).toBe(true);
        }

        // 意味 (品質ゲート): 明白な文脈は正しく分類されるべき。
        expect(m.get(candidateKey("円明"))?.suggestedType).toBe("character");
        expect(m.get(candidateKey("帝都アルカディア"))?.suggestedType).toBe(
          "location",
        );
        expect(m.get(candidateKey("星辰剣"))?.suggestedType).toBe("item");
        // 既存エントリ「田中太郎」の別名として「田中」を検出する。
        expect(m.get(candidateKey("田中"))?.aliasOfId).toBe("e-tanaka");
      },
      LIVE_TIMEOUT,
    );
  },
);
