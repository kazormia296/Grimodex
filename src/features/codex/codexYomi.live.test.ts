/**
 * Codex 表記の読み(ふりがな)推定の **ライブ** 品質 E2E（実 LLM）。
 *
 * **本番のプロンプトビルダー (codexYomi.buildYomiEstimationPrompt) と本番のパーサ
 * (parseYomiResponse) を import** して使い（再構築によるドリフトを避ける）、
 * {@link runLiveSingleShot} で実モデルに 1 往復投げ、推定品質を検証する:
 * - 構造: yomi はひらがなのみ・入力 surface に対応する。
 * - 意味: 明白な読みの漢字表記が妥当なひらがな読みになるか。
 *
 * 既定 SKIP。実行（実トークン課金あり）:
 *   OPENROUTER_API_KEY=sk-... pnpm test --run \
 *     src/features/codex/codexYomi.live.test.ts
 *   モデル上書き: OPENROUTER_MODEL（既定 openai/gpt-4o-mini）。
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
import { parseYomiResponse } from "./codexYomi";
import { hasKanji } from "./reading";

const KEY = liveApiKey();
const LIVE_TIMEOUT = 120_000;
const cat = getPromptCatalog("ja");

// 明白な読みの評価用フィクスチャ (人物名 / 地名)。
const ENTRIES = [
  { id: "e-setsuna", category: "人物", surfaces: ["刹那"] },
  { id: "e-teito", category: "場所", surfaces: ["帝都"] },
];

const EXPECTED: Record<string, string> = {
  刹那: "せつな",
  帝都: "ていと",
};

describe.skipIf(!KEY)(`codex yomi estimation live E2E (${liveModel()})`, () => {
  it(
    "本番プロンプト×実モデルで漢字表記のひらがな読みが得られる",
    async () => {
      const prompt = cat.codexYomi.buildYomiEstimationPrompt({
        entries: ENTRIES,
      });
      const validSurfacesById = new Map(
        ENTRIES.map((e) => [e.id, new Set(e.surfaces)]),
      );

      const { text } = await runLiveSingleShot(prompt);
      const m = parseYomiResponse(text, validSurfacesById);

      for (const e of ENTRIES) {
        for (const r of m.get(e.id) ?? []) {
          console.log(`[yomi] ${r.surface} -> ${r.yomi}`);
        }
      }

      // 構造: 返った読みはすべてひらがな (漢字残りなし)。
      for (const list of m.values()) {
        for (const r of list) {
          expect(r.yomi.length).toBeGreaterThan(0);
          expect(hasKanji(r.yomi)).toBe(false);
        }
      }

      // 意味 (品質ゲート): 明白な読みは期待どおり。
      expect(m.get("e-setsuna")?.[0]?.yomi).toBe(EXPECTED["刹那"]);
      expect(m.get("e-teito")?.[0]?.yomi).toBe(EXPECTED["帝都"]);
    },
    LIVE_TIMEOUT,
  );
});
