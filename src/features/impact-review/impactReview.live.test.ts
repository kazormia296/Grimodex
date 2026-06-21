/**
 * impact-review の **ライブ** E2E（実 LLM）。
 *
 * 本番の JA `impactReviewSystem` プロンプトと本番の diff ビルダー
 * ({@link computeCodexDiff}) を import して使い（再構築ドリフト回避）、Rust
 * `call_post_effect_api` と同じ `[Codex]`/`[Scene]` フレーミングで実モデルへ 1 往復
 * 投げる。検証するのは 2 点:
 *   1. フェーズ別の説明(content override)の編集が `phase_content` 差分として渡り、
 *      旧値を反映した本文を judgments[] で指摘できる（フェーズ対応の確定バグ修正）。
 *   2. 翻訳した JA プロンプトで判定が回り、reason が日本語で返る。
 *
 * 既定 SKIP（キー無しは describe.skipIf でスキップ）。実行（実トークン課金あり）:
 *   OPENROUTER_API_KEY=sk-... pnpm test --run \
 *     src/features/impact-review/impactReview.live.test.ts
 *   モデル上書き: OPENROUTER_MODEL（既定 openai/gpt-4o-mini。本番 impact_review は
 *   ロール設定で Opus へルーティングされるため anthropic 系での実行を推奨）。
 */
import { describe, it, expect, vi } from "vitest";

// aiLiveHarness は agentLoop→contextBuilder を読み込むため tokenizer WASM ロードを
// 避ける（singleShot.live.test.ts と同じ）。runLiveSingleShot 自体は tokenizer 不要。
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
import {
  computeCodexDiff,
  summarizeChanges,
  computeChangeId,
  type CodexSnapshot,
} from "./diff";

const KEY = liveApiKey();
const LIVE_TIMEOUT = 120_000;

// 朱音の「第2部」フェーズ別の説明(content override)を、村娘 → 王都の騎士団隊長へ
// 変更したシナリオ。base content は空のまま = フェーズ別の編集だけが差分になる
// （base のみ見ると取りこぼす＝今回の確定バグ）。
const PHASE_LABEL = "第2部";
const OLD_CONTENT =
  "朱音は故郷の村で薬草を摘んで暮らす、剣を握ったこともない娘。";
const NEW_CONTENT = "朱音は王都の騎士団に入り、剣を振るって戦う隊長になった。";

const baseline: CodexSnapshot = {
  name: "朱音",
  aliases: [],
  summary: "物語の主人公。",
  contentPlain: "",
  details: [],
  phases: [
    {
      phaseId: "p2",
      label: PHASE_LABEL,
      summary: null,
      contentPlain: OLD_CONTENT,
      details: [],
    },
  ],
};
const current: CodexSnapshot = {
  ...baseline,
  phases: [
    {
      phaseId: "p2",
      label: PHASE_LABEL,
      summary: null,
      contentPlain: NEW_CONTENT,
      details: [],
    },
  ],
};

// 第2部に属する本文。旧説明(村娘・剣未経験)を反映 = 新説明(騎士団隊長)と矛盾する。
const SCENE =
  "第二部。朱音は今日も村の畑で薬草を摘んでいた。土と緑のにおいに包まれた静かな暮らし。剣など一度も握ったことはなく、戦いとは無縁の日々だった。";

describe.skipIf(!KEY)(`impact-review live E2E (${liveModel()})`, () => {
  it(
    "フェーズ別 content の old→new が渡り、旧値を反映した本文を日本語 reason で指摘する",
    async () => {
      const changes = computeCodexDiff(baseline, current);
      // 前提: フェーズ別 content 変更「だけ」が検出される（base は不変）。
      expect(changes).toEqual([
        {
          field: "phase_content",
          name: null,
          phase: PHASE_LABEL,
          old: OLD_CONTENT,
          new: NEW_CONTENT,
        },
      ]);

      const diffPayload = {
        change_id: computeChangeId("char-akane", changes),
        entry_id: "char-akane",
        entry_name: "朱音",
        entry_type: "character",
        change_summary: summarizeChanges(changes),
        changes,
      };

      const system = getPromptCatalog("ja").postEffect.impactReviewSystem;
      // call_post_effect_api と同じ [Codex]/[Scene] フレーミング。
      const user = `[Codex]\n${JSON.stringify(diffPayload)}\n\n[Scene]\n${SCENE}`;

      const { text } = await runLiveSingleShot(user, { system });
      // vitest は console.log を抑制するため、解析用に env でファイルダンプ可能に
      // する（既定 no-op）。IMPACT_LIVE_OUT=/path pnpm test ... で有効。
      if (process.env.IMPACT_LIVE_OUT) {
        (await import("node:fs")).writeFileSync(
          process.env.IMPACT_LIVE_OUT,
          `model=${liveModel()}\n\n--- raw ---\n${text}\n`,
        );
      }

      const json = extractJsonObject(text);
      expect(json, `JSON 抽出失敗: ${text.slice(0, 200)}`).not.toBeNull();
      const parsed = JSON.parse(json as string) as {
        judgments?: Array<{
          found_text?: unknown;
          reason?: unknown;
          contradiction_score?: unknown;
          confidence?: unknown;
        }>;
      };
      expect(Array.isArray(parsed.judgments)).toBe(true);
      const judgments = parsed.judgments ?? [];
      // 明確な矛盾を仕込んだので最低 1 件は出るはず。
      expect(
        judgments.length,
        `judgments 空: ${text.slice(0, 200)}`,
      ).toBeGreaterThan(0);

      // 少なくとも 1 件が本文の正確な部分文字列に紐づく（アンカー＋変更理解）。
      const anchored = judgments.filter(
        (j) => typeof j.found_text === "string" && SCENE.includes(j.found_text),
      );
      expect(
        anchored.length,
        `本文に紐づく judgment が無い: ${JSON.stringify(judgments).slice(0, 300)}`,
      ).toBeGreaterThan(0);

      // 少なくとも 1 件の reason が日本語(CJK を含む) = 翻訳 JA プロンプトが効いている。
      const jaReason = judgments.filter(
        (j) => typeof j.reason === "string" && /[぀-ヿ一-鿿]/.test(j.reason),
      );
      expect(
        jaReason.length,
        `日本語 reason が無い: ${JSON.stringify(judgments).slice(0, 300)}`,
      ).toBeGreaterThan(0);

      // 契約: contradiction_score は数値、confidence は enum。
      for (const j of judgments) {
        expect(typeof j.contradiction_score).toBe("number");
        expect(["high", "medium", "low"]).toContain(j.confidence);
      }
    },
    LIVE_TIMEOUT,
  );
});
