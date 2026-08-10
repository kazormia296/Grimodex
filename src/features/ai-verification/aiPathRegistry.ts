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
import { BROWSER_DIRECT_AI_PROVIDERS } from "@/features/chat/browserProviderPolicy";
import type { AiProvider } from "@/features/chat/types";
import type { AiDataConsentRoute } from "@/features/ai-policy/aiDataConsent";

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
  /** 実モデルを必要としない transport / audit contract test。 */
  | "contract"
  /** 自動検証不可（外部バイナリ依存等）。gap を note に明示する。 */
  | "stub"
  /** LLM 生成経路ではない（埋め込み/検索）。 */
  | "n/a";

/** 完全監査イベントを発行する境界の正本。 */
export type AiAuditOwner =
  | "renderer-agent"
  | "renderer-single-shot"
  | "renderer-stream"
  | "renderer-transport"
  | "electron-runtime"
  | "browser-runtime"
  | "native-post-effect"
  | "native-semantic"
  | "evaluation-harness"
  | "none";

/**
 * `full-observable` は dispatch 前 request と観測可能な全 terminal/event を保存する。
 * `partial-observable` は宣言済み limitation により一部の観測値を fingerprint 等で保存する。
 * provider 内部の非公開 chain-of-thought は観測可能範囲に含まれない。
 */
export type AiAuditCaptureLevel =
  | "full-observable"
  | "partial-observable"
  | "control-event"
  | "not-applicable";

export interface AiPathEntry {
  /** 一意な経路 ID。 */
  id: string;
  /** 人間向けラベル。 */
  label: string;
  /** 本番の呼び出し箇所（file:fn 目安）。 */
  surface: string;
  layer: AiPathLayer;
  /** 実際の到達トランスポート（typed preload IPC command 名 等）。 */
  transport: string;
  /** request/response 監査を所有する一意な境界。 */
  auditOwner: AiAuditOwner;
  /** その境界が保証する監査粒度。 */
  captureLevel: AiAuditCaptureLevel;
  /** full-observable を証明する deterministic contract test。 */
  auditTestRef: string | null;
  /** auditTestRef 内に実在する経路固有のテスト名。 */
  auditTestName?: string;
  verifier: AiPathVerifier;
  /**
   * 検証テストの所在（リポジトリルート相対）。js-live/rust-live/covered-by-agent-loop
   * は実在ファイル必須。stub/n/a は null。
   */
  testRef: string | null;
  /**
   * testRef 内に実在すべきテスト名の一部（it/describe の文字列、または Rust の fn 名）。
   * 任意（後方互換）。指定したエントリは完全性メタテストが testRef を読み込み、
   * この文字列が含まれることを assert する（ファイル存在だけでなく中身まで照合）。
   */
  testName?: string;
  /** 検証手段の説明、または gap の明示。 */
  note: string;
}

/**
 * A deployed runtime route for an existing AI surface.
 *
 * `AI_PATHS` remains the canonical logical surface/model-role registry. These
 * entries separately prove that the browser transport does not disappear
 * behind the Electron/Rust transport names and that each external-data route
 * has a consent verifier. Runtime routes do not create an additional model
 * role; they carry the role selected explicitly by the user.
 */
export interface AiRuntimeRouteEntry {
  id: string;
  label: string;
  surface: string;
  transport: string;
  auditOwner: AiAuditOwner;
  captureLevel: AiAuditCaptureLevel;
  auditTestRef: string;
  auditTestName: string;
  consentRoute: AiDataConsentRoute;
  providerAuthority: "user-selection";
  providers: readonly AiProvider[];
  capabilityGate: string;
  verifier: "contract";
  testRef: string;
  testName: string;
  consentTestRef: string;
  consentTestName: string;
  note: string;
}

/**
 * Renderer callsites that must carry a path-specific audit identity into a
 * typed model boundary. The registry completeness test parses these real
 * production files and requires the literal to occur in the named call
 * expression; merely mentioning a path in a test is not sufficient.
 */
export interface AiAuditRendererCallsite {
  pathId: string;
  sourceRef: string;
  dispatchCall: string;
  auditProperty: "pathId" | "auditPathId";
}

export const AI_AUDIT_RENDERER_CALLSITES: readonly AiAuditRendererCallsite[] = [
  {
    pathId: "chat_agent_main",
    sourceRef: "src/application/chat/chatTurnStoreActions.ts",
    dispatchCall: "chatApi.sendAgentMessage",
    auditProperty: "pathId",
  },
  {
    pathId: "agent_research_subagent",
    sourceRef: "src/application/chat/chatTurnStoreActions.ts",
    dispatchCall: "chatApi.sendAgentMessage",
    auditProperty: "pathId",
  },
  {
    pathId: "context_creator",
    sourceRef: "src/features/chat/contextCreatorApi.ts",
    dispatchCall: "sendAgentMessage",
    auditProperty: "pathId",
  },
  {
    pathId: "synopsis",
    sourceRef: "src/features/chat/chatApi.ts",
    dispatchCall: "invokeSingleShotChat",
    auditProperty: "pathId",
  },
  {
    pathId: "session_title",
    sourceRef: "src/features/chat/chatApi.ts",
    dispatchCall: "invokeSingleShotChat",
    auditProperty: "pathId",
  },
  {
    pathId: "summarization",
    sourceRef: "src/application/chat/chatSummarization.ts",
    dispatchCall: "chatApi.sendChatMessageWithThinking",
    auditProperty: "pathId",
  },
  {
    pathId: "foreshadow_audit_chapter",
    sourceRef: "src/features/foreshadow/api.ts",
    dispatchCall: "sendChatMessageWithThinking",
    auditProperty: "pathId",
  },
  {
    pathId: "foreshadow_propose_past_setups",
    sourceRef: "src/features/foreshadow/api.ts",
    dispatchCall: "sendChatMessageWithThinking",
    auditProperty: "pathId",
  },
  {
    pathId: "foreshadow_evaluate_setup_strength",
    sourceRef: "src/features/foreshadow/api.ts",
    dispatchCall: "sendChatMessageWithThinking",
    auditProperty: "pathId",
  },
  {
    pathId: "plot_thread_propose",
    sourceRef: "src/features/plot-threads/extractThreadsApi.ts",
    dispatchCall: "sendChatMessageWithThinking",
    auditProperty: "pathId",
  },
  {
    pathId: "chronicle_extract",
    sourceRef: "src/features/chronicle/extractEventsApi.ts",
    dispatchCall: "sendChatMessageWithThinking",
    auditProperty: "pathId",
  },
  {
    pathId: "narrative_observation_extract",
    sourceRef:
      "src/application/narrative-extraction/aiTasks/runObservationExtractionTask.ts",
    dispatchCall: "sendChatMessageWithThinking",
    auditProperty: "pathId",
  },
  {
    pathId: "narrative_event_synthesize",
    sourceRef:
      "src/application/narrative-extraction/aiTasks/runEventSynthesisTask.ts",
    dispatchCall: "sendChatMessageWithThinking",
    auditProperty: "pathId",
  },
  {
    pathId: "narrative_entity_resolve",
    sourceRef:
      "src/application/narrative-extraction/aiTasks/runEntityResolutionTask.ts",
    dispatchCall: "sendChatMessageWithThinking",
    auditProperty: "pathId",
  },
  {
    pathId: "narrative_relation_synthesize",
    sourceRef:
      "src/application/narrative-extraction/aiTasks/runRelationSynthesisTask.ts",
    dispatchCall: "sendChatMessageWithThinking",
    auditProperty: "pathId",
  },
  {
    pathId: "narrative_structured_repair",
    sourceRef:
      "src/application/narrative-extraction/aiTasks/runStructuredRepairTask.ts",
    dispatchCall: "sendChatMessageWithThinking",
    auditProperty: "pathId",
  },
  {
    pathId: "beat_role",
    sourceRef: "src/features/editor/beat/inferMentionRoles.ts",
    dispatchCall: "sendChatMessageWithThinking",
    auditProperty: "pathId",
  },
  {
    pathId: "codex_yomi",
    sourceRef: "src/features/codex/codexYomi.ts",
    dispatchCall: "sendChatMessageWithThinking",
    auditProperty: "pathId",
  },
  {
    pathId: "map_branch",
    sourceRef: "src/features/map/mapAiApi.ts",
    dispatchCall: "invokeSingleShotChat",
    auditProperty: "pathId",
  },
  {
    pathId: "tree_scaffold",
    sourceRef: "src/features/tree/aiScaffold/generate.ts",
    dispatchCall: "invokeSingleShotChat",
    auditProperty: "pathId",
  },
  {
    pathId: "ab_chat",
    sourceRef: "src/features/ab-test/abDispatchers.ts",
    dispatchCall: "sendChatMessageOnceAb",
    auditProperty: "pathId",
  },
  {
    pathId: "ai_connection_test",
    sourceRef: "src/features/chat/api.ts",
    dispatchCall: "beginAiAuditExecution",
    auditProperty: "pathId",
  },
  {
    pathId: "chat_stream_non_agent",
    sourceRef: "src/application/chat/chatTurnStoreActions.ts",
    dispatchCall: "chatApi.sendChatMessageStream",
    auditProperty: "pathId",
  },
  {
    pathId: "inline_ai_stream",
    sourceRef: "src/features/editor/inlineAi/inlineAiApi.ts",
    dispatchCall: "sendInlineAiStream",
    auditProperty: "pathId",
  },
  {
    pathId: "ab_inline",
    sourceRef: "src/features/ab-test/abDispatchers.ts",
    dispatchCall: "streamInlineAiText",
    auditProperty: "auditPathId",
  },
  {
    pathId: "beat_generation",
    sourceRef: "src/features/editor/beat/generateBeatOnce.ts",
    dispatchCall: "sendInlineAiStream",
    auditProperty: "pathId",
  },
  {
    pathId: "beat_generation",
    sourceRef: "src/features/editor/beat/useBeatGeneration.ts",
    dispatchCall: "sendInlineAiStream",
    auditProperty: "pathId",
  },
  {
    pathId: "beat_alternative",
    sourceRef: "src/features/editor/beat/generateBeatAlternative.ts",
    dispatchCall: "streamInlineAiText",
    auditProperty: "auditPathId",
  },
  {
    pathId: "beats_from_synopsis",
    sourceRef: "src/features/editor/beat/generateBeatsFromSynopsis.ts",
    dispatchCall: "streamInlineAiText",
    auditProperty: "auditPathId",
  },
  {
    pathId: "synopsis_from_beats",
    sourceRef: "src/features/editor/beat/generateSynopsisFromBeats.ts",
    dispatchCall: "streamInlineAiText",
    auditProperty: "auditPathId",
  },
  {
    pathId: "codex_app_server",
    sourceRef: "src/features/chat/codexAppApi.ts",
    dispatchCall: "beginAiAuditExecutionInWorkspace",
    auditProperty: "pathId",
  },
  {
    pathId: "codex_app_cli_fallback",
    sourceRef: "src/features/chat/codexAppApi.ts",
    dispatchCall: "fallbackAiAuditExecution",
    auditProperty: "pathId",
  },
  {
    pathId: "cli_chat_stream",
    sourceRef: "src/application/chat/chatTurnStoreActions.ts",
    dispatchCall: "cliApi.sendCliChatStream",
    auditProperty: "pathId",
  },
] as const;

const AGENT_LOOP_TEST = "src/features/chat/agent/agentToolCall.live.test.ts";
const SINGLE_SHOT_TEST = "src/features/ai-verification/singleShot.live.test.ts";
const RELATION_EVAL_TEST =
  "src/features/codex/relationInjectionEval.live.test.ts";
const CODEX_YOMI_TEST = "src/features/codex/codexYomi.live.test.ts";
const CANDIDATE_JUDGMENT_TEST =
  "src/features/codex/candidateJudgment.live.test.ts";
const POST_EFFECT_RUST = "src-tauri/src/commands/post_effect.rs";
const BROWSER_BYOK_CONTRACT_TEST = "src/lib/browser-ai.test.ts";
const BROWSER_BYOK_CONSENT_CONTRACT_TEST =
  "src/lib/browser-mock.ai-runtime.test.ts";
const AGENT_AND_CHAT_AUDIT_TEST = "src/features/chat/chatApi.audit.test.ts";
const SINGLE_SHOT_AUDIT_TEST =
  "src/features/chat/singleShotTransport.audit.test.ts";
const INLINE_AUDIT_TEST =
  "src/features/editor/inlineAi/inlineAiStreaming.audit.test.ts";
const ELECTRON_RUNTIME_AUDIT_TEST =
  "src/features/chat/externalRuntimeAudit.test.ts";
const POST_EFFECT_AUDIT_TEST =
  "src-tauri/crates/grimodex-post-effect/src/audit_tests.rs";
const SEMANTIC_AUDIT_TEST =
  "src-tauri/crates/grimodex-semantic/src/audit_tests.rs";
const BROWSER_AUDIT_TEST = "src/lib/browser-mock.ai-audit.test.ts";

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
    auditOwner: "renderer-agent",
    captureLevel: "full-observable",
    auditTestRef: AGENT_AND_CHAT_AUDIT_TEST,
    auditTestName: "AI audit path: chat_agent_main",
    verifier: "covered-by-agent-loop",
    testRef: AGENT_LOOP_TEST,
    testName: "S1:",
    note: "ツールループ・最終回答到達を S1 が実モデルで検証。ループは JS 側なのでハーネスが忠実再現（sendToLLM のみ差し替え）。",
  },
  {
    id: "agent_research_subagent",
    label: "run_research サブエージェント（depth=1）",
    surface: "chatStore.ts guardedExecuteTool → 子 runAgentLoop",
    layer: "agent",
    transport: "send_agent_message",
    auditOwner: "renderer-agent",
    captureLevel: "full-observable",
    auditTestRef: AGENT_AND_CHAT_AUDIT_TEST,
    auditTestName: "AI audit path: agent_research_subagent",
    verifier: "covered-by-agent-loop",
    testRef: AGENT_LOOP_TEST,
    testName: "S2:",
    note: "S2 が親→子委譲と子の自前 read（depth=1, 非再帰）を実モデルで検証。createResearchInterceptor で再現。",
  },
  {
    id: "agent_call_limit",
    label: "model-aware ツールコール上限",
    surface: "agentLoop.ts maxToolCalls",
    layer: "agent",
    transport: "send_agent_message",
    auditOwner: "renderer-agent",
    captureLevel: "control-event",
    auditTestRef: null,
    verifier: "covered-by-agent-loop",
    testRef: AGENT_LOOP_TEST,
    testName: "S3:",
    note: "S3 が上限到達での打ち切り（stoppedReason=limit_calls）を検証。",
  },
  {
    id: "context_creator",
    label: "Context Creator（Codex 提案）",
    surface: "contextCreatorApi.ts runContextCreator → runAgentLoop",
    layer: "agent",
    transport: "send_agent_message",
    auditOwner: "renderer-agent",
    captureLevel: "full-observable",
    auditTestRef: AGENT_AND_CHAT_AUDIT_TEST,
    auditTestName: "AI audit path: context_creator",
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
    auditOwner: "renderer-single-shot",
    captureLevel: "full-observable",
    auditTestRef: SINGLE_SHOT_AUDIT_TEST,
    auditTestName: "AI audit path: synopsis",
    verifier: "js-live",
    testRef: SINGLE_SHOT_TEST,
    testName: "synopsis:",
    note: "本番ビルダー chatApi.buildSynopsisFromContentPrompt + runLiveSingleShot。非空テキストを assert。",
  },
  {
    id: "session_title",
    label: "セッションタイトル自動生成",
    surface: "chatApi.ts generateSessionTitle",
    layer: "single-shot",
    transport: "send_chat_message",
    auditOwner: "renderer-single-shot",
    captureLevel: "full-observable",
    auditTestRef: SINGLE_SHOT_AUDIT_TEST,
    auditTestName: "AI audit path: session_title",
    verifier: "js-live",
    testRef: SINGLE_SHOT_TEST,
    testName: "session_title:",
    note: "本番ビルダー chatApi.buildSessionTitlePrompt + runLiveSingleShot。",
  },
  {
    id: "summarization",
    label: "会話の引き継ぎ要約",
    surface: "summarization.ts runSummarization",
    layer: "single-shot",
    transport: "send_chat_message",
    auditOwner: "renderer-single-shot",
    captureLevel: "full-observable",
    auditTestRef: SINGLE_SHOT_AUDIT_TEST,
    auditTestName: "AI audit path: summarization",
    verifier: "js-live",
    testRef: SINGLE_SHOT_TEST,
    testName: "summarization:",
    note: "本番ビルダー summarization.buildPrompt（実 ChatMessage[]）+ runLiveSingleShot。",
  },
  {
    id: "foreshadow_audit_chapter",
    label: "伏線監査（章スキャン）",
    surface: "foreshadow/api.ts auditChapter",
    layer: "single-shot",
    transport: "send_chat_message",
    auditOwner: "renderer-single-shot",
    captureLevel: "full-observable",
    auditTestRef: SINGLE_SHOT_AUDIT_TEST,
    auditTestName: "AI audit path: foreshadow_audit_chapter",
    verifier: "js-live",
    testRef: SINGLE_SHOT_TEST,
    testName: "foreshadow.auditChapter:",
    note: "本番ビルダー foreshadow.buildAuditChapterPrompt + 本番パーサ extractJsonObject。candidates 形を assert。",
  },
  {
    id: "plot_thread_propose",
    label: "プロットスレッド抽出（Phase 4a）",
    surface: "plot-threads/extractThreadsApi.ts proposePlotThreads",
    layer: "single-shot",
    transport: "send_chat_message",
    auditOwner: "renderer-single-shot",
    captureLevel: "full-observable",
    auditTestRef: SINGLE_SHOT_AUDIT_TEST,
    auditTestName: "AI audit path: plot_thread_propose",
    verifier: "js-live",
    testRef: SINGLE_SHOT_TEST,
    testName: "plot_thread_propose:",
    note: "本番ビルダー plotThread.buildProposePlotThreadsPrompt + 本番パーサ extractJsonObject。threads 形を assert。",
  },
  {
    id: "chronicle_extract",
    label: "作中年表イベント抽出（Run surface / compatibility）",
    surface: "chronicle/extractEventsApi.ts proposeEvents",
    layer: "single-shot",
    transport: "send_chat_message",
    auditOwner: "renderer-single-shot",
    captureLevel: "full-observable",
    auditTestRef: SINGLE_SHOT_AUDIT_TEST,
    auditTestName: "AI audit path: chronicle_extract",
    verifier: "contract",
    testRef: SINGLE_SHOT_AUDIT_TEST,
    testName: "AI audit path: chronicle_extract",
    note: "Run surface / 旧一括抽出 façade。Stage AI は narrative_observation_extract / narrative_event_synthesize / narrative_structured_repair。cutover まで compatibility callsite を残す。",
  },
  {
    id: "narrative_observation_extract",
    label: "Narrative Observation 抽出",
    surface:
      "narrative-extraction/aiTasks/runObservationExtractionTask.ts runObservationExtractionTask",
    layer: "single-shot",
    transport: "send_chat_message",
    auditOwner: "renderer-single-shot",
    captureLevel: "full-observable",
    auditTestRef: SINGLE_SHOT_AUDIT_TEST,
    auditTestName: "AI audit path: narrative_observation_extract",
    verifier: "contract",
    testRef: SINGLE_SHOT_AUDIT_TEST,
    testName: "AI audit path: narrative_observation_extract",
    note: "Window 単位の Event Observation。Source View ref（S0001…）のみ渡し、Project/Scene/Event DB ID は送らない。",
  },
  {
    id: "narrative_event_synthesize",
    label: "Narrative Event Synthesis",
    surface:
      "narrative-extraction/aiTasks/runEventSynthesisTask.ts runEventSynthesisTask",
    layer: "single-shot",
    transport: "send_chat_message",
    auditOwner: "renderer-single-shot",
    captureLevel: "full-observable",
    auditTestRef: SINGLE_SHOT_AUDIT_TEST,
    auditTestName: "AI audit path: narrative_event_synthesize",
    verifier: "contract",
    testRef: SINGLE_SHOT_AUDIT_TEST,
    testName: "AI audit path: narrative_event_synthesize",
    note: "Cluster 単位の Event Hypothesis 合成。Observation ref と短い Evidence 表示のみ。",
  },
  {
    id: "narrative_entity_resolve",
    label: "Narrative Entity Resolution",
    surface:
      "narrative-extraction/aiTasks/runEntityResolutionTask.ts runEntityResolutionTask",
    layer: "single-shot",
    transport: "send_chat_message",
    auditOwner: "renderer-single-shot",
    captureLevel: "full-observable",
    auditTestRef: SINGLE_SHOT_AUDIT_TEST,
    auditTestName: "AI audit path: narrative_entity_resolve",
    verifier: "contract",
    testRef: SINGLE_SHOT_AUDIT_TEST,
    testName: "AI audit path: narrative_entity_resolve",
    note: "Codex Entity Cluster の同定。不透明 Type／Entry Catalog Ref（T####／K####）と Source View Ref のみ渡し、実 DB Entry ID は送らない。",
  },
  {
    id: "narrative_relation_synthesize",
    label: "Narrative Relation Synthesis",
    surface:
      "narrative-extraction/aiTasks/runRelationSynthesisTask.ts runRelationSynthesisTask",
    layer: "single-shot",
    transport: "send_chat_message",
    auditOwner: "renderer-single-shot",
    captureLevel: "full-observable",
    auditTestRef: SINGLE_SHOT_AUDIT_TEST,
    auditTestName: "AI audit path: narrative_relation_synthesize",
    verifier: "contract",
    testRef: SINGLE_SHOT_AUDIT_TEST,
    testName: "AI audit path: narrative_relation_synthesize",
    note: "Candidate Entity ペアの Relation Hypothesis 合成。Narrative Entity ID と Observation ref のみ。実 Codex Entry ID は送らない。",
  },
  {
    id: "narrative_structured_repair",
    label: "Narrative Structured JSON Repair",
    surface:
      "narrative-extraction/aiTasks/runStructuredRepairTask.ts runStructuredRepairTask",
    layer: "single-shot",
    transport: "send_chat_message",
    auditOwner: "renderer-single-shot",
    captureLevel: "full-observable",
    auditTestRef: SINGLE_SHOT_AUDIT_TEST,
    auditTestName: "AI audit path: narrative_structured_repair",
    verifier: "contract",
    testRef: SINGLE_SHOT_AUDIT_TEST,
    testName: "AI audit path: narrative_structured_repair",
    note: "Observation／Synthesis の JSON 失敗時に最大 1 回だけ呼ぶ構造化修復 Path。",
  },
  {
    id: "foreshadow_propose_past_setups",
    label: "伏線 setup 候補提案",
    surface: "foreshadow/api.ts proposePastSetups",
    layer: "single-shot",
    transport: "send_chat_message",
    auditOwner: "renderer-single-shot",
    captureLevel: "full-observable",
    auditTestRef: SINGLE_SHOT_AUDIT_TEST,
    auditTestName: "AI audit path: foreshadow_propose_past_setups",
    verifier: "js-live",
    testRef: SINGLE_SHOT_TEST,
    testName: "foreshadow.proposePastSetups:",
    note: "本番ビルダー foreshadow.buildProposePastSetupsPrompt + extractJsonObject。",
  },
  {
    id: "foreshadow_evaluate_setup_strength",
    label: "伏線強度評価（3 ペルソナ）",
    surface: "foreshadow/api.ts evaluateSetupStrength",
    layer: "single-shot",
    transport: "send_chat_message",
    auditOwner: "renderer-single-shot",
    captureLevel: "full-observable",
    auditTestRef: SINGLE_SHOT_AUDIT_TEST,
    auditTestName: "AI audit path: foreshadow_evaluate_setup_strength",
    verifier: "js-live",
    testRef: SINGLE_SHOT_TEST,
    testName: "foreshadow.evaluateSetupStrength:",
    note: "本番ビルダー foreshadow.buildEvaluateSetupStrengthPrompt + 本番パーサ safeParseAiEvaluation。",
  },
  {
    id: "beat_role",
    label: "ビート言及の役割推論",
    surface: "editor/beat/inferMentionRoles.ts",
    layer: "single-shot",
    transport: "send_chat_message",
    auditOwner: "renderer-single-shot",
    captureLevel: "full-observable",
    auditTestRef: SINGLE_SHOT_AUDIT_TEST,
    auditTestName: "AI audit path: beat_role",
    verifier: "js-live",
    testRef: SINGLE_SHOT_TEST,
    testName: "beat_role:",
    note: "本番ビルダー inferMentionRoles.buildPrompt + extractJsonObject。results[].role を assert。",
  },
  {
    id: "codex_judgment",
    label: "Codex 候補の LLM 判定（種別/要約/別名）",
    surface: "codex/candidateJudgment.ts judgeCandidates",
    layer: "single-shot",
    transport: "send_chat_message",
    auditOwner: "renderer-single-shot",
    captureLevel: "full-observable",
    auditTestRef: SINGLE_SHOT_AUDIT_TEST,
    auditTestName: "AI audit path: codex_judgment",
    verifier: "js-live",
    testRef: CANDIDATE_JUDGMENT_TEST,
    testName: "codex candidate judgment live E2E",
    note: "本番ビルダー codexJudgment.buildCandidateJudgmentPrompt + 本番パーサ parseJudgmentResponse + runLiveSingleShot。形態素×LLM の LLM 半分（種別分類/別名検出）を実モデルで検証。",
  },
  {
    id: "codex_yomi",
    label: "Codex 表記の読み(ふりがな)推定",
    surface: "codex/codexYomi.ts inferReadings",
    layer: "single-shot",
    transport: "send_chat_message",
    auditOwner: "renderer-single-shot",
    captureLevel: "full-observable",
    auditTestRef: SINGLE_SHOT_AUDIT_TEST,
    auditTestName: "AI audit path: codex_yomi",
    verifier: "js-live",
    testRef: CODEX_YOMI_TEST,
    testName: "codex yomi estimation live E2E",
    note: "本番ビルダー codexYomi.buildYomiEstimationPrompt + 本番パーサ parseYomiResponse + runLiveSingleShot。漢字表記のひらがな読み推定を実モデルで検証。",
  },
  {
    id: "map_branch",
    label: "Map AI Branch カード生成",
    surface: "map/mapAiApi.ts generateAiBranchCards",
    layer: "single-shot",
    transport: "send_chat_message",
    auditOwner: "renderer-single-shot",
    captureLevel: "full-observable",
    auditTestRef: SINGLE_SHOT_AUDIT_TEST,
    auditTestName: "AI audit path: map_branch",
    verifier: "js-live",
    testRef: SINGLE_SHOT_TEST,
    testName: "map_branch:",
    note: "本番 buildSystemPrompt/buildUserPrompt + 本番パーサ parseCards。doc 形・枚数を assert。VS(意外性ノブ)有効時は VS-on/off の構造多様性(LLM盲検A/B)+語彙を比較計測。",
  },
  {
    id: "tree_scaffold",
    label: "Tree scaffold/再編プラン生成",
    surface: "tree/aiScaffold/generate.ts generateAiTreePlan",
    layer: "single-shot",
    transport: "send_chat_message",
    auditOwner: "renderer-single-shot",
    captureLevel: "full-observable",
    auditTestRef: SINGLE_SHOT_AUDIT_TEST,
    auditTestName: "AI audit path: tree_scaffold",
    verifier: "js-live",
    testRef: SINGLE_SHOT_TEST,
    testName: "tree_scaffold:",
    note: "本番 buildSystemPrompt/buildUserPrompt + 本番パーサ parseTreePlan。ops 配列・create op を assert。",
  },
  {
    id: "ab_chat",
    label: "A/B 比較（chat 枠）",
    surface: "ab-test/abDispatchers.ts createChatAbDispatcher",
    layer: "single-shot",
    transport: "send_chat_message",
    auditOwner: "renderer-single-shot",
    captureLevel: "full-observable",
    auditTestRef: SINGLE_SHOT_AUDIT_TEST,
    auditTestName: "AI audit path: ab_chat",
    verifier: "contract",
    testRef: SINGLE_SHOT_AUDIT_TEST,
    testName: "AI audit path: ab_chat",
    note: "各 A/B 枠を独立 execution とし、slot 固有 provider/model/prompt variant を保存する。",
  },
  {
    id: "ai_connection_test",
    label: "AI 接続テスト（最小推論）",
    surface: "chat/api.ts testAiConnection",
    layer: "single-shot",
    transport: "test_ai_connection",
    auditOwner: "renderer-single-shot",
    captureLevel: "full-observable",
    auditTestRef: SINGLE_SHOT_AUDIT_TEST,
    auditTestName: "AI audit path: ai_connection_test",
    verifier: "contract",
    testRef: SINGLE_SHOT_AUDIT_TEST,
    testName: "AI audit path: ai_connection_test",
    note: "設定画面で project 未選択でも実行できるため workspace chain に記録する。既知の固定 probe prompt と requested route、response/error は保存する。Electronではrendererへreceiptを返さないが、instrument済みnative HTTP observerがRequestBuilderのbody bytesからparseした完全なJSON値を同じexecutionへdurable appendしてからsendする（prompt/body値は完全、serialization whitespace/object key orderは非保持）。WebもBrowserMock/browser-aiがfetchへ渡す同じbodyJsonをparseした完全なJSON値をdurable appendしてからfetchする（serialization whitespace/object key order/bytesは非保持）。credentialは除外し、共通observerを通らないnative HTTP経路はこの保証の対象外。",
  },
  {
    id: "relation_injection",
    label: "relation 注入の出力 eval",
    surface: "codex/relationInjectionEval",
    layer: "single-shot",
    transport: "direct-fetch (OpenRouter)",
    auditOwner: "evaluation-harness",
    captureLevel: "control-event",
    auditTestRef: null,
    verifier: "js-live",
    testRef: RELATION_EVAL_TEST,
    testName: "relation injection live eval",
    note: "Vitest の .live.test.ts から開発者が明示実行する合成fixture専用eval。製品bundle／project workspace／帰属レポートから到達不可なため、賞レースproject ledgerではなくevaluation-harnessのcontrol-eventとする。",
  },

  // ── ③ ストリーミング ──────────────────────────────────────────────────────
  {
    id: "chat_stream_non_agent",
    label: "本文チャット（非 agent, ストリーミング）",
    surface: "chatApi.ts sendChatMessageStream",
    layer: "streaming",
    transport: "send_chat_message_stream",
    auditOwner: "renderer-stream",
    captureLevel: "full-observable",
    auditTestRef: AGENT_AND_CHAT_AUDIT_TEST,
    auditTestName: "AI audit path: chat_stream_non_agent",
    verifier: "js-live",
    testRef: SINGLE_SHOT_TEST,
    testName: "streaming surfaces:",
    note: "OpenRouter リクエスト挙動を runLiveSingleShot で検証。chat:stream-* は Electron main→N-API EventQueue→typed preload IPC→renderer の専用経路で配信し、各deltaをdurable response.partialへ保存後にUIへ渡す（OpenRouterハーネスでは非再現）。",
  },
  {
    id: "inline_ai_stream",
    label: "エディタ inline AI 補完（ストリーミング）",
    surface: "editor/inlineAi/inlineAiStreaming.ts",
    layer: "streaming",
    transport: "send_inline_ai_stream",
    auditOwner: "renderer-stream",
    captureLevel: "full-observable",
    auditTestRef: INLINE_AUDIT_TEST,
    auditTestName: "AI audit path: inline_ai_stream",
    verifier: "js-live",
    testRef: SINGLE_SHOT_TEST,
    testName: "inline_ai_output:",
    note: "本番ビルダー inlineAiApi.buildSystemPrompt/buildUserPrompt（= getPromptCatalog().inlineAi）を実 InlineAiContext で組み、runLiveSingleShot で実モデル出力を QA（continue=文脈の続き生成／rewrite=選択文の別表現化）。inline-ai:stream-* は Electron main→N-API EventQueue→typed preload IPC→renderer の専用経路で配信し、各deltaをdurable response.partialへ保存後にUIへ渡す。リニア（LinearSceneBlock/useLinearInlineAi）は EditorPane と同一builder/transportを再利用する。",
  },
  {
    id: "ab_inline",
    label: "A/B 比較（inline 枠）",
    surface: "ab-test/abDispatchers.ts createInlineAbDispatcher",
    layer: "streaming",
    transport: "send_inline_ai_stream",
    auditOwner: "renderer-stream",
    captureLevel: "full-observable",
    auditTestRef: INLINE_AUDIT_TEST,
    auditTestName: "AI audit path: ab_inline",
    verifier: "contract",
    testRef: INLINE_AUDIT_TEST,
    testName: "AI audit path: ab_inline",
    note: "逐次実行される各 A/B 枠を独立 execution として監査する。",
  },
  {
    id: "beat_generation",
    label: "Beat 本文生成",
    surface: "editor/beat/generateBeatOnce.ts / useBeatGeneration.ts",
    layer: "streaming",
    transport: "send_inline_ai_stream",
    auditOwner: "renderer-stream",
    captureLevel: "full-observable",
    auditTestRef: INLINE_AUDIT_TEST,
    auditTestName: "AI audit path: beat_generation",
    verifier: "contract",
    testRef: INLINE_AUDIT_TEST,
    testName: "AI audit path: beat_generation",
    note: "Beat prompt、stream partial、採否に関係しない terminal を完全保存する。",
  },
  {
    id: "beat_alternative",
    label: "Beat 代替案生成",
    surface: "editor/beat/generateBeatAlternative.ts",
    layer: "streaming",
    transport: "send_inline_ai_stream",
    auditOwner: "renderer-stream",
    captureLevel: "full-observable",
    auditTestRef: INLINE_AUDIT_TEST,
    auditTestName: "AI audit path: beat_alternative",
    verifier: "contract",
    testRef: INLINE_AUDIT_TEST,
    testName: "AI audit path: beat_alternative",
    note: "Snippet 採用前の代替案生成も独立した AI execution として保存する。",
  },
  {
    id: "beats_from_synopsis",
    label: "あらすじから Beat 生成",
    surface: "editor/beat/generateBeatsFromSynopsis.ts",
    layer: "streaming",
    transport: "send_inline_ai_stream",
    auditOwner: "renderer-stream",
    captureLevel: "full-observable",
    auditTestRef: INLINE_AUDIT_TEST,
    auditTestName: "AI audit path: beats_from_synopsis",
    verifier: "contract",
    testRef: INLINE_AUDIT_TEST,
    testName: "AI audit path: beats_from_synopsis",
    note: "直接本文でない構成生成も synopsis 入力を含む完全監査対象。",
  },
  {
    id: "synopsis_from_beats",
    label: "Beat からシーンあらすじ生成",
    surface: "editor/beat/generateSynopsisFromBeats.ts",
    layer: "streaming",
    transport: "send_inline_ai_stream",
    auditOwner: "renderer-stream",
    captureLevel: "full-observable",
    auditTestRef: INLINE_AUDIT_TEST,
    auditTestName: "AI audit path: synopsis_from_beats",
    verifier: "contract",
    testRef: INLINE_AUDIT_TEST,
    testName: "AI audit path: synopsis_from_beats",
    note: "Beat 群から生成する metadata 的あらすじも完全監査対象。",
  },

  // ── ④ Rust 校閲 post-effect graders ──────────────────────────────────────
  {
    id: "post_effect_intent_drift",
    label: "校閲: intent drift（意図ずれ）",
    surface: "post_effect.rs process_* → ai::call_post_effect_api",
    layer: "post-effect",
    transport: "call_post_effect_api",
    auditOwner: "native-post-effect",
    captureLevel: "full-observable",
    auditTestRef: POST_EFFECT_AUDIT_TEST,
    auditTestName:
      "audit_records_exact_request_route_and_raw_response_before_returning",
    verifier: "rust-live",
    testRef: POST_EFFECT_RUST,
    testName: "intent_drift_live",
    note: "Rust 側 #[cfg(test)] ライブテストが実 OpenRouter を叩き、extract_json + JSON parse の到達経路を検証（プロンプト/解析が Rust 側のため Rust で検証）。",
  },
  {
    id: "post_effect_review",
    label: "校閲: review（編集診断）",
    surface: "post_effect.rs → ai::call_post_effect_api",
    layer: "post-effect",
    transport: "call_post_effect_api",
    auditOwner: "native-post-effect",
    captureLevel: "full-observable",
    auditTestRef: POST_EFFECT_AUDIT_TEST,
    auditTestName:
      "audit_records_exact_request_route_and_raw_response_before_returning",
    verifier: "rust-live",
    testRef: POST_EFFECT_RUST,
    testName: "review_live",
    note: "同上。review 用の代表プロンプトで JSON 到達を検証。",
  },
  {
    id: "post_effect_consistency",
    label: "校閲: consistency（Codex 矛盾）",
    surface: "post_effect.rs → ai::call_post_effect_api",
    layer: "post-effect",
    transport: "call_post_effect_api",
    auditOwner: "native-post-effect",
    captureLevel: "full-observable",
    auditTestRef: POST_EFFECT_AUDIT_TEST,
    auditTestName:
      "audit_records_exact_request_route_and_raw_response_before_returning",
    verifier: "rust-live",
    testRef: POST_EFFECT_RUST,
    testName: "consistency_with_codex_live",
    note: "同上。Codex content（cache_control 境界）を付けた経路を検証。",
  },
  {
    id: "post_effect_intra_scene_consistency",
    label: "校閲: intra-scene consistency（シーン内矛盾）",
    surface: "grimodex-post-effect run_intra_task → call_post_effect_api",
    layer: "post-effect",
    transport: "call_post_effect_api",
    auditOwner: "native-post-effect",
    captureLevel: "full-observable",
    auditTestRef: POST_EFFECT_AUDIT_TEST,
    auditTestName:
      "audit_records_exact_request_route_and_raw_response_before_returning",
    verifier: "contract",
    testRef: POST_EFFECT_AUDIT_TEST,
    testName:
      "audit_records_exact_request_route_and_raw_response_before_returning",
    note: "Codex 無しの scene payload も run ではなく provider call 単位で監査する。",
  },
  {
    id: "post_effect_typo_detection",
    label: "校閲: typo detection（誤字脱字）",
    surface: "grimodex-post-effect run_typo_task → call_post_effect_api",
    layer: "post-effect",
    transport: "call_post_effect_api",
    auditOwner: "native-post-effect",
    captureLevel: "full-observable",
    auditTestRef: POST_EFFECT_AUDIT_TEST,
    auditTestName:
      "audit_records_exact_request_route_and_raw_response_before_returning",
    verifier: "contract",
    testRef: POST_EFFECT_AUDIT_TEST,
    testName:
      "audit_records_exact_request_route_and_raw_response_before_returning",
    note: "誤字脱字診断の system/scene payload と構造化応答を保存する。",
  },
  {
    id: "post_effect_meta_structure",
    label: "校閲: meta structure（構造・ペーシング）",
    surface:
      "grimodex-post-effect run_meta_structure_task → call_post_effect_api",
    layer: "post-effect",
    transport: "call_post_effect_api",
    auditOwner: "native-post-effect",
    captureLevel: "full-observable",
    auditTestRef: POST_EFFECT_AUDIT_TEST,
    auditTestName:
      "audit_records_exact_request_route_and_raw_response_before_returning",
    verifier: "contract",
    testRef: POST_EFFECT_AUDIT_TEST,
    testName:
      "audit_records_exact_request_route_and_raw_response_before_returning",
    note: "本文を書き換えない構造診断も完全監査対象。",
  },
  {
    id: "post_effect_timeline_consistency",
    label: "校閲: timeline consistency（複数シーン）",
    surface: "post_effect.rs multi-scene → ai::call_post_effect_api",
    layer: "post-effect",
    transport: "call_post_effect_api",
    auditOwner: "native-post-effect",
    captureLevel: "full-observable",
    auditTestRef: POST_EFFECT_AUDIT_TEST,
    auditTestName:
      "audit_records_exact_request_route_and_raw_response_before_returning",
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
    auditOwner: "native-post-effect",
    captureLevel: "full-observable",
    auditTestRef: POST_EFFECT_AUDIT_TEST,
    auditTestName:
      "audit_records_exact_request_route_and_raw_response_before_returning",
    verifier: "rust-live",
    testRef: POST_EFFECT_RUST,
    note: "同上。",
  },
  {
    id: "post_effect_live_pseudo_comment",
    label: "校閲: live reader pseudo comment",
    surface: "post-effect/liveReaderRuntime.ts → live pseudo_comment",
    layer: "post-effect",
    transport: "call_post_effect_api",
    auditOwner: "native-post-effect",
    captureLevel: "full-observable",
    auditTestRef: POST_EFFECT_AUDIT_TEST,
    auditTestName: "live_pseudo_comment_has_a_distinct_audit_path",
    verifier: "contract",
    testRef: POST_EFFECT_AUDIT_TEST,
    testName: "live_pseudo_comment_has_a_distinct_audit_path",
    note: "非対話的なライブ読者コメントを通常 pseudo_comment と別経路で追跡する。",
  },
  {
    id: "post_effect_impact_review",
    label: "校閲: impact review（変更影響レビュー）",
    surface:
      "post_effect.rs process_impact_review_scene → ai::call_post_effect_api",
    layer: "post-effect",
    transport: "call_post_effect_api",
    auditOwner: "native-post-effect",
    captureLevel: "full-observable",
    auditTestRef: POST_EFFECT_AUDIT_TEST,
    auditTestName:
      "audit_records_exact_request_route_and_raw_response_before_returning",
    verifier: "rust-live",
    testRef: POST_EFFECT_RUST,
    testName: "impact_review_with_diff_live",
    note: "同上。変更された Codex 設定 (old→new) の差分を Codex ブロックとして Some(..) で渡し（cache_control 境界）、本文の矛盾箇所を judgments[] で返させる経路を Rust ライブテスト (impact_review_with_diff_live) が検証。",
  },

  // ── ⑤ Codex App Server / CLI 外部 runtime ────────────────────────────────
  {
    id: "codex_app_server",
    label: "Codex App Server chat turn",
    surface: "chat/codexAppApi.ts sendCodexAppTurn",
    layer: "cli",
    transport: "codex_app_start_turn",
    auditOwner: "electron-runtime",
    captureLevel: "partial-observable",
    auditTestRef: ELECTRON_RUNTIME_AUDIT_TEST,
    auditTestName: "AI audit path: codex_app_server",
    verifier: "contract",
    testRef: ELECTRON_RUNTIME_AUDIT_TEST,
    testName: "AI audit path: codex_app_server",
    note: "Grimodex が供給した developer/context/history/user prompt と App Server から観測した delta/item/thinking/usage event は完全保存する。外部 runtime が内部生成する追加 prompt と provider private reasoning は観測不能のため partial として明示する。",
  },
  {
    id: "codex_app_cli_fallback",
    label: "Codex App Server pre-turn rejection → codex exec fallback",
    surface: "chat/codexAppApi.ts startFallback",
    layer: "cli",
    transport: "codex_app_start_turn → subprocess (cli:stream-*)",
    auditOwner: "electron-runtime",
    captureLevel: "partial-observable",
    auditTestRef: ELECTRON_RUNTIME_AUDIT_TEST,
    auditTestName: "AI audit path: codex_app_cli_fallback",
    verifier: "contract",
    testRef: ELECTRON_RUNTIME_AUDIT_TEST,
    testName: "AI audit path: codex_app_cli_fallback",
    note: "元 execution の rejected-before-turn と子 fallback execution を parent/fallback event で結ぶ。Grimodex が供給した fallback prompt と観測 delta は完全保存するが、外部 CLI が内部生成する追加 prompt と provider private reasoning は観測不能のため partial とする。",
  },
  {
    id: "cli_chat_stream",
    label: "CLI プロバイダ（claude/codex/opencode）",
    surface: "chat/cliApi.ts sendCliChatStream",
    layer: "cli",
    transport: "subprocess (cli:stream-*)",
    auditOwner: "electron-runtime",
    captureLevel: "partial-observable",
    auditTestRef: ELECTRON_RUNTIME_AUDIT_TEST,
    auditTestName: "AI audit path: cli_chat_stream",
    verifier: "stub",
    testRef: null,
    note: "Grimodex が供給した CLI prompt/model/options と観測 delta は完全保存する。外部 CLI が内部生成する追加 prompt と provider private reasoning は観測不能のため partial とし、外部バイナリ・認証・PATH 依存の実機 smoke gap も明示する。",
  },

  // ── ⑥ 埋め込み / 全文検索（LLM 生成ではない）──────────────────────────────
  {
    id: "semantic_search",
    label: "意味検索（dense 埋め込み）",
    surface:
      "semantic-search/api.ts semanticSearch / searchCodex / searchEvents / searchChatMessages",
    layer: "embedding",
    transport: "semantic_search (Rust ONNX)",
    auditOwner: "native-semantic",
    captureLevel: "partial-observable",
    auditTestRef: SEMANTIC_AUDIT_TEST,
    auditTestName: "AI audit path: semantic_search",
    verifier: "n/a",
    testRef: null,
    note: "LLM 生成ではなく埋め込み推論。per-input sessionが始まった場合はraw/model-visible textと実際にparseしたtokenizer.jsonのbyte SHAを正確に保存するが、cold artifact loadがsession開始前に失敗したqueryはtokenization/ONNXへ到達せずモデル利用もない一方、その高位operationのper-input lifecycleはledgerに残らない。さらにrealized token IDs、special-token展開、truncation後token列は保持せず、生vectorもdimension+SHA表現のため partial-observable。品質は searchEval.ts / 決定的 eval で別途評価。",
  },
  {
    id: "semantic_embedding_index",
    label: "scene/Codex/event/chat の埋め込み index",
    surface:
      "semantic-search/api.ts index*/reindex* + scheduler background jobs",
    layer: "embedding",
    transport: "semantic_index_* (Rust ONNX)",
    auditOwner: "native-semantic",
    captureLevel: "partial-observable",
    auditTestRef: SEMANTIC_AUDIT_TEST,
    auditTestName: "AI audit path: semantic_embedding_index",
    verifier: "contract",
    testRef: SEMANTIC_AUDIT_TEST,
    testName: "AI audit path: semantic_embedding_index",
    note: "自動 background index もper-input session開始後はraw/model-visible text、実際にparseしたtokenizer.jsonのbyte SHA、model fingerprint、成功/失敗/中止をinference単位で保存する。cold artifact loadがsession開始前に失敗したchunkはtokenization/ONNXへ到達せずモデル利用もない一方、試行された高位operationのper-input lifecycleはledgerに残らない。realized token IDs、special-token展開、truncation後token列は保持せず、生vectorもdimension+SHA表現のため partial-observable。",
  },
  {
    id: "semantic_reranker",
    label: "関連シーン候補のローカル再順位付け",
    surface: "chat/semanticRerankerApply.ts applySemanticReranker",
    layer: "embedding",
    transport: "semantic_reranker_score (Rust ONNX)",
    auditOwner: "native-semantic",
    captureLevel: "partial-observable",
    auditTestRef: SEMANTIC_AUDIT_TEST,
    auditTestName: "AI audit path: semantic_reranker",
    verifier: "n/a",
    testRef: null,
    note: "LLM 生成ではない固定モデル推論。raw query/candidate、model-visible pair text、score、実際にparseしたtokenizer.jsonのbyte SHAは保存するが、realized token IDs、special-token展開、truncation後token列は保持しないため partial-observable。embeddingと異なりcold artifact load失敗もinitial raw requestとterminalをledgerに残す。Gate 2 の固定fixture・速度評価と semanticRerankerApply.test.ts の admission不変/fail-safe 契約で検証する。",
  },
  {
    id: "semantic_reranker_shadow",
    label: "関連シーン候補の shadow 再順位付け",
    surface: "chat/semanticRerankerShadow.ts runSemanticRerankerShadow",
    layer: "embedding",
    transport: "semantic_reranker_score (Rust ONNX)",
    auditOwner: "native-semantic",
    captureLevel: "partial-observable",
    auditTestRef: SEMANTIC_AUDIT_TEST,
    auditTestName: "AI audit path: semantic_reranker_shadow",
    verifier: "contract",
    testRef: SEMANTIC_AUDIT_TEST,
    testName: "AI audit path: semantic_reranker_shadow",
    note: "採用順へ影響しない shadow 推論も raw query/candidates、model-visible pair text、scores、実際にparseしたtokenizer.jsonのbyte SHA、terminal を保存する。cold artifact load失敗もinitial raw requestとterminalが残る。realized token IDs、special-token展開、truncation後token列は保持しないため partial-observable。",
  },
  {
    id: "fts_search",
    label: "全文検索（FTS5 / BM25 sparse）",
    surface: "chat/semanticRecall.ts fts_search",
    layer: "embedding",
    transport: "fts_search (Rust SQLite)",
    auditOwner: "none",
    captureLevel: "not-applicable",
    auditTestRef: null,
    verifier: "n/a",
    testRef: null,
    note: "LLM ではなく BM25 ランキング。semanticRecall.test.ts（決定的）で融合ロジックを検証。",
  },
];

/** Web Editor transports and their fail-closed consent contracts. */
export const AI_RUNTIME_ROUTES: AiRuntimeRouteEntry[] = [
  {
    id: "browser_byok_web",
    label: "Web Editor HTTP Local LLM / BYOK AI",
    surface: "browser Editor → BrowserMock AI transport → browser-ai",
    transport: "browser fetch → user-selected AI provider",
    auditOwner: "browser-runtime",
    captureLevel: "full-observable",
    auditTestRef: BROWSER_AUDIT_TEST,
    auditTestName:
      "durably receipts the complete JSON value parsed from the Browser fetch body",
    consentRoute: "byok",
    providerAuthority: "user-selection",
    providers: BROWSER_DIRECT_AI_PROVIDERS,
    capabilityGate:
      "explicit user-selected HTTP provider + configured endpoint where required + session-memory credential when required + current route/provider/policy/actual connection destination consent",
    verifier: "contract",
    testRef: BROWSER_BYOK_CONTRACT_TEST,
    testName: "resolves every Web Editor provider endpoint",
    consentTestRef: BROWSER_BYOK_CONSENT_CONTRACT_TEST,
    consentTestName:
      "does not reach the provider when consent authorization fails",
    note: "Web Editor exposes every HTTP provider (OpenRouter, OpenAI, Anthropic, Ollama, OpenAI-compatible, Sakana, and AI Novelist) with user-owned credentials or a user-configured endpoint; native CLI remains desktop-only and Web Editor has no app-owned credential or managed provider route. The common renderer wrapper owns one execution. BrowserMock parses the same bodyJson string passed to fetch, appends its complete credential-free JSON value as request.prepared to that execution, and awaits the durable journal ACK before fetch. JSON semantics, provider framing, transformed tool history, and effective max tokens are retained; serialization whitespace, key order, byte representation, headers, and runtime credentials are not. Connection probes use the same workspace-scoped ai_connection_test audit. Model listing is control-plane activity: a selected cold Ollama model can trigger the consent-gated prompt-free /api/generate {model, stream:false} runner preload, which may load weights/allocate the runner but supplies no prompt and requests no token generation or model output, so it is outside the generative/inference ledger. Consent identity includes the normalized actual connection destination, so changing an endpoint invalidates prior consent. This static runtime-route entry does not create a distinct ledger path or prove that the route was used.",
  },
];
