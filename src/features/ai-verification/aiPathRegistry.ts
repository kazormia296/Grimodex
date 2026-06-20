/**
 * AI 経路レジストリ — アプリ内の全 AI 呼び出し経路の一覧と、その検証手段の正本。
 *
 * 目的: 「全ての経路を検証できる」ことを **機械チェック可能** にする単一の真実源。
 * 新しい AI 生成サーフェスを足したら、ここにエントリを 1 つ追加する。追加し忘れ／
 * 検証手段の欠落は {@link file://./aiPathRegistry.test.ts} の完全性メタテストが落とす。
 *
 * 経路の分類（transport）と検証可否の境界は docs/AI経路検証.md に詳説。要点:
 *   - JS が全部オーケストレーションする経路（agent loop / 単発）は OpenRouter を
 *     直接叩く {@link file://../chat/agent/aiLiveHarness.ts} で**忠実に**検証できる。
 *   - Rust が全部オーケストレーションする経路（校閲 post-effect）は Rust 側の
 *     ライブテストで検証する。
 *   - CLI サブプロセスは外部バイナリ依存のため自動検証不可（stub として明示）。
 *   - 埋め込み/全文検索は LLM 生成ではない（n/a）。
 */

/** 経路の到達トランスポート層。 */
export type AiPathLayer =
  /** runAgentLoop（ツールコール agent）。transport=send_agent_message。 */
  | "agent"
  /** tool 無しの 1 往復。transport=send_chat_message。 */
  | "single-shot"
  /** ストリーミング配信。transport=send_chat_message_stream / send_inline_ai_stream。 */
  | "streaming"
  /** Rust 校閲 grader。transport=call_post_effect_api（Rust 内 HTTP）。 */
  | "post-effect"
  /** CLI プロバイダ（claude/codex/opencode）サブプロセス。 */
  | "cli"
  /** 埋め込み / 全文検索（LLM 生成ではない）。 */
  | "embedding";

/** 各経路をどう検証するか。 */
export type AiPathVerifier =
  /** aiLiveHarness を使う *.live.test.ts（JS, 実モデル）。 */
  | "js-live"
  /** Rust の #[cfg(test)] ライブテスト（実モデル）。 */
  | "rust-live"
  /** 汎用 agent ループのライブ E2E（agentToolCall.live.test.ts）で経路として網羅。 */
  | "covered-by-agent-loop"
  /** 自動検証不可（外部バイナリ依存等）。gap を note に明示する。 */
  | "stub"
  /** LLM 生成経路ではない（埋め込み/検索）。 */
  | "n/a";

export interface AiPathEntry {
  /** 一意な経路 ID。 */
  id: string;
  /** 人間向けラベル。 */
  label: string;
  /** 本番の呼び出し箇所（file:fn 目安）。 */
  surface: string;
  layer: AiPathLayer;
  /** 実際の到達トランスポート（Tauri command 名 等）。 */
  transport: string;
  verifier: AiPathVerifier;
  /**
   * 検証テストの所在（リポジトリルート相対）。js-live/rust-live/covered-by-agent-loop
   * は実在ファイル必須。stub/n/a は null。
   */
  testRef: string | null;
  /** 検証手段の説明、または gap の明示。 */
  note: string;
}

const AGENT_LOOP_TEST = "src/features/chat/agent/agentToolCall.live.test.ts";
const SINGLE_SHOT_TEST = "src/features/ai-verification/singleShot.live.test.ts";
const RELATION_EVAL_TEST =
  "src/features/codex/relationInjectionEval.live.test.ts";
const POST_EFFECT_RUST = "src-tauri/src/commands/post_effect.rs";

/** 生成経路（LLM を実際に叩く層）。n/a が許されない層。 */
export const GENERATION_LAYERS: AiPathLayer[] = [
  "agent",
  "single-shot",
  "streaming",
  "post-effect",
  "cli",
];

export const AI_PATHS: AiPathEntry[] = [
  // ── ① agent loop（runAgentLoop / send_agent_message）─────────────────────
  {
    id: "chat_agent_main",
    label: "Chat Agent 本体（agentMode）",
    surface: "chatStore.ts sendMessage → runAgentLoop",
    layer: "agent",
    transport: "send_agent_message",
    verifier: "covered-by-agent-loop",
    testRef: AGENT_LOOP_TEST,
    note: "ツールループ・最終回答到達を S1 が実モデルで検証。ループは JS 側なのでハーネスが忠実再現（sendToLLM のみ差し替え）。",
  },
  {
    id: "agent_research_subagent",
    label: "run_research サブエージェント（depth=1）",
    surface: "chatStore.ts guardedExecuteTool → 子 runAgentLoop",
    layer: "agent",
    transport: "send_agent_message",
    verifier: "covered-by-agent-loop",
    testRef: AGENT_LOOP_TEST,
    note: "S2 が親→子委譲と子の自前 read（depth=1, 非再帰）を実モデルで検証。createResearchInterceptor で再現。",
  },
  {
    id: "agent_call_limit",
    label: "model-aware ツールコール上限",
    surface: "agentLoop.ts maxToolCalls",
    layer: "agent",
    transport: "send_agent_message",
    verifier: "covered-by-agent-loop",
    testRef: AGENT_LOOP_TEST,
    note: "S3 が上限到達での打ち切り（stoppedReason=limit_calls）を検証。",
  },
  {
    id: "context_creator",
    label: "Context Creator（Codex 提案）",
    surface: "contextCreatorApi.ts runContextCreator → runAgentLoop",
    layer: "agent",
    transport: "send_agent_message",
    verifier: "covered-by-agent-loop",
    testRef: AGENT_LOOP_TEST,
    note: "同一の agent ループ経路（runAgentLoop + send_agent_message）を agentToolCall.live.test.ts が実モデルで検証。Context Creator はその構成違い（固有 system prompt + 4-tool サブセット + parseSuggestedEntries）。固有プロンプト/パーサ単体のライブ検証は defer（toolExecutors の重い import グラフを避けるため。経路としては網羅済み）。",
  },

  // ── ② 単発（send_chat_message, tool 無し）─────────────────────────────────
  {
    id: "synopsis",
    label: "あらすじ生成",
    surface: "chatApi.ts generateSynopsisFromContent",
    layer: "single-shot",
    transport: "send_chat_message",
    verifier: "js-live",
    testRef: SINGLE_SHOT_TEST,
    note: "本番ビルダー chatApi.buildSynopsisFromContentPrompt + runLiveSingleShot。非空テキストを assert。",
  },
  {
    id: "session_title",
    label: "セッションタイトル自動生成",
    surface: "chatApi.ts generateSessionTitle",
    layer: "single-shot",
    transport: "send_chat_message",
    verifier: "js-live",
    testRef: SINGLE_SHOT_TEST,
    note: "本番ビルダー chatApi.buildSessionTitlePrompt + runLiveSingleShot。",
  },
  {
    id: "summarization",
    label: "会話の引き継ぎ要約",
    surface: "summarization.ts runSummarization",
    layer: "single-shot",
    transport: "send_chat_message",
    verifier: "js-live",
    testRef: SINGLE_SHOT_TEST,
    note: "本番ビルダー summarization.buildPrompt（実 ChatMessage[]）+ runLiveSingleShot。",
  },
  {
    id: "foreshadow_audit_chapter",
    label: "伏線監査（章スキャン）",
    surface: "foreshadow/api.ts auditChapter",
    layer: "single-shot",
    transport: "send_chat_message",
    verifier: "js-live",
    testRef: SINGLE_SHOT_TEST,
    note: "本番ビルダー foreshadow.buildAuditChapterPrompt + 本番パーサ extractJsonObject。candidates 形を assert。",
  },
  {
    id: "foreshadow_propose_past_setups",
    label: "伏線 setup 候補提案",
    surface: "foreshadow/api.ts proposePastSetups",
    layer: "single-shot",
    transport: "send_chat_message",
    verifier: "js-live",
    testRef: SINGLE_SHOT_TEST,
    note: "本番ビルダー foreshadow.buildProposePastSetupsPrompt + extractJsonObject。",
  },
  {
    id: "foreshadow_evaluate_setup_strength",
    label: "伏線強度評価（3 ペルソナ）",
    surface: "foreshadow/api.ts evaluateSetupStrength",
    layer: "single-shot",
    transport: "send_chat_message",
    verifier: "js-live",
    testRef: SINGLE_SHOT_TEST,
    note: "本番ビルダー foreshadow.buildEvaluateSetupStrengthPrompt + 本番パーサ safeParseAiEvaluation。",
  },
  {
    id: "beat_role",
    label: "ビート言及の役割推論",
    surface: "editor/beat/inferMentionRoles.ts",
    layer: "single-shot",
    transport: "send_chat_message",
    verifier: "js-live",
    testRef: SINGLE_SHOT_TEST,
    note: "本番ビルダー inferMentionRoles.buildPrompt + extractJsonObject。results[].role を assert。",
  },
  {
    id: "map_branch",
    label: "Map AI Branch カード生成",
    surface: "map/mapAiApi.ts generateAiBranchCards",
    layer: "single-shot",
    transport: "send_chat_message",
    verifier: "js-live",
    testRef: SINGLE_SHOT_TEST,
    note: "本番 buildSystemPrompt/buildUserPrompt + 本番パーサ parseCards。doc 形・枚数を assert。VS(意外性ノブ)有効時は VS-on/off の語彙多様性を比較計測。",
  },
  {
    id: "tree_scaffold",
    label: "Tree scaffold/再編プラン生成",
    surface: "tree/aiScaffold/generate.ts generateAiTreePlan",
    layer: "single-shot",
    transport: "send_chat_message",
    verifier: "js-live",
    testRef: SINGLE_SHOT_TEST,
    note: "本番 buildSystemPrompt/buildUserPrompt + 本番パーサ parseTreePlan。ops 配列・create op を assert。",
  },
  {
    id: "relation_injection",
    label: "relation 注入の出力 eval",
    surface: "codex/relationInjectionEval",
    layer: "single-shot",
    transport: "direct-fetch (OpenRouter)",
    verifier: "js-live",
    testRef: RELATION_EVAL_TEST,
    note: "既存のライブ eval。生成アーム + judge モデルで relation 注入の cost/benefit を採点。",
  },

  // ── ③ ストリーミング ──────────────────────────────────────────────────────
  {
    id: "chat_stream_non_agent",
    label: "本文チャット（非 agent, ストリーミング）",
    surface: "chatApi.ts sendChatMessageStream",
    layer: "streaming",
    transport: "send_chat_message_stream",
    verifier: "js-live",
    testRef: SINGLE_SHOT_TEST,
    note: "OpenRouter リクエスト挙動を runLiveSingleShot で検証。chat:stream-* イベント配信は Rust/Tauri IPC 層の責務（OpenRouter ハーネスでは非再現＝この境界は意図的に範囲外）。",
  },
  {
    id: "inline_ai_stream",
    label: "エディタ inline AI 補完（ストリーミング）",
    surface: "editor/inlineAi/inlineAiStreaming.ts",
    layer: "streaming",
    transport: "send_inline_ai_stream",
    verifier: "js-live",
    testRef: SINGLE_SHOT_TEST,
    note: "リクエスト挙動は runLiveSingleShot で検証。inline-ai:stream-* イベント配信は Rust/Tauri 層（非再現）。",
  },

  // ── ④ Rust 校閲 post-effect graders ──────────────────────────────────────
  {
    id: "post_effect_intent_drift",
    label: "校閲: intent drift（意図ずれ）",
    surface: "post_effect.rs process_* → ai::call_post_effect_api",
    layer: "post-effect",
    transport: "call_post_effect_api",
    verifier: "rust-live",
    testRef: POST_EFFECT_RUST,
    note: "Rust 側 #[cfg(test)] ライブテストが実 OpenRouter を叩き、extract_json + JSON parse の到達経路を検証（プロンプト/解析が Rust 側のため Rust で検証）。",
  },
  {
    id: "post_effect_review",
    label: "校閲: review（編集診断）",
    surface: "post_effect.rs → ai::call_post_effect_api",
    layer: "post-effect",
    transport: "call_post_effect_api",
    verifier: "rust-live",
    testRef: POST_EFFECT_RUST,
    note: "同上。review 用の代表プロンプトで JSON 到達を検証。",
  },
  {
    id: "post_effect_consistency",
    label: "校閲: consistency（Codex 矛盾）",
    surface: "post_effect.rs → ai::call_post_effect_api",
    layer: "post-effect",
    transport: "call_post_effect_api",
    verifier: "rust-live",
    testRef: POST_EFFECT_RUST,
    note: "同上。Codex content（cache_control 境界）を付けた経路を検証。",
  },
  {
    id: "post_effect_timeline_consistency",
    label: "校閲: timeline consistency（複数シーン）",
    surface: "post_effect.rs multi-scene → ai::call_post_effect_api",
    layer: "post-effect",
    transport: "call_post_effect_api",
    verifier: "rust-live",
    testRef: POST_EFFECT_RUST,
    note: "同上。multi-scene 系も同一の call_post_effect_api を通るため Rust ライブテストで到達検証。",
  },
  {
    id: "post_effect_pseudo_comment",
    label: "校閲: pseudo comment（疑似コメント）",
    surface: "post_effect.rs → ai::call_post_effect_api",
    layer: "post-effect",
    transport: "call_post_effect_api",
    verifier: "rust-live",
    testRef: POST_EFFECT_RUST,
    note: "同上。",
  },
  {
    id: "post_effect_impact_review",
    label: "校閲: impact review（変更影響レビュー）",
    surface:
      "post_effect.rs process_impact_review_scene → ai::call_post_effect_api",
    layer: "post-effect",
    transport: "call_post_effect_api",
    verifier: "rust-live",
    testRef: POST_EFFECT_RUST,
    note: "同上。変更された Codex 設定 (old→new) の差分を Codex ブロックとして Some(..) で渡し（cache_control 境界）、本文の矛盾箇所を judgments[] で返させる経路を Rust ライブテスト (impact_review_with_diff_live) が検証。",
  },

  // ── ⑤ CLI サブプロセス（自動検証不可）────────────────────────────────────
  {
    id: "cli_chat_stream",
    label: "CLI プロバイダ（claude/codex/opencode）",
    surface: "chat/cliApi.ts sendCliChatStream",
    layer: "cli",
    transport: "subprocess (cli:stream-*)",
    verifier: "stub",
    testRef: null,
    note: "外部 CLI バイナリ + 認証 + PATH 解決に依存するため OpenRouter ハーネスでは自動検証不可。実機 smoke でのみ確認可能（既知の gap として明示）。",
  },

  // ── ⑥ 埋め込み / 全文検索（LLM 生成ではない）──────────────────────────────
  {
    id: "semantic_search",
    label: "意味検索（dense 埋め込み）",
    surface: "semantic-search/api.ts semanticSearch",
    layer: "embedding",
    transport: "semantic_search (Rust ONNX)",
    verifier: "n/a",
    testRef: null,
    note: "LLM 生成ではなく埋め込み推論。品質は searchEval.ts / 決定的 eval で別途評価。",
  },
  {
    id: "fts_search",
    label: "全文検索（FTS5 / BM25 sparse）",
    surface: "chat/semanticRecall.ts fts_search",
    layer: "embedding",
    transport: "fts_search (Rust SQLite)",
    verifier: "n/a",
    testRef: null,
    note: "LLM ではなく BM25 ランキング。semanticRecall.test.ts（決定的）で融合ロジックを検証。",
  },
];
