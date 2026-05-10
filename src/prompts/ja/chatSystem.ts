import type { L1TrimMarkers, L3TrimMarkers } from "../shared/types";

export const JA_L1_TRIM_MARKERS: L1TrimMarkers = {
  removablePatterns: [
    /\n文体ガイド:\n[\s\S]*?(?=\n[^\s]|$)/,
    /\nAI指示:\n[\s\S]*?(?=\n[^\s]|$)/,
    /\nジャンル:[^\n]*/,
    /\n視点:[^\n]*/,
    /\n時制:[^\n]*/,
  ],
};

export const JA_L3_TRIM_MARKERS: L3TrimMarkers = {
  bodyHeaderRegex: /([\s\S]*?### シーン本文\n)/,
};

export const JA_TYPE_LABELS: Record<string, string> = {
  character: "キャラクター",
  location: "場所",
  item: "アイテム",
  lore: "設定",
};

export const JA_CHAT_SYSTEM = {
  baseText:
    "あなたは小説執筆を支援するAIアシスタントです。" +
    "ユーザーの執筆スタイルを尊重し、創造的な提案や文章の改善を行ってください。",

  /**
   * Agent モード時のみ baseText に続けて注入する追加指示。
   * 「事前注入された情報を起点に、不足時のみツールを使う」という
   * 階層的アクセス前提を明示する。
   */
  agentInstruction:
    "プロジェクトデータを検索・取得するツールが利用可能です。" +
    "ただし、回答に必要な情報の大半は下記の事前注入セクション" +
    "（プロジェクト情報・現在のシーン・登場キャラクター・設定情報・会話の要約）" +
    "に既に含まれています。まず事前注入セクションを確認し、" +
    "そこにある情報で答えられる場合はツールを呼び出さないでください。\n\n" +
    "重要: 「登場キャラクター・設定情報」セクションに既に出ているエントリは、" +
    "id・別名・概要・カスタム detail（`- フィールド名: 値`）・全文 が " +
    "そのまま注入されています。同じエントリに対して `get_codex_entry` を呼んでも、" +
    "それ以上の情報は基本的に得られません（追加で取得できるのは子エントリの一覧 `children` のみ）。" +
    "事前注入されたエントリは再取得せず、注入内容をそのまま回答に使ってください。\n\n" +
    "ツールを使う場面は次の 3 つに限定してください: " +
    "(1) 事前注入されていないエントリの探索 (`list_codex_by_type` / `search_codex`)、" +
    "(2) 注入されたエントリに関連する他エントリの探索 — " +
    "「〇〇に関連するエントリは？」「〇〇の所持品は？」「〇〇に登場する場所は？」のような関係質問には " +
    "`find_related_entries(id, type?)` を使ってください。" +
    "id には注入セクションの `id: ...` 行から起点エントリの UUID を渡し、" +
    "必要なら type で絞り込みます (例: 朱音の所持品 → `find_related_entries(朱音の id, 'item')`)。" +
    "この関係質問のために `search_codex` に複数語の自然言語クエリを渡しても期待通りには動きません。" +
    "(3) 注入されたエントリの子エントリ一覧が必要なとき (`get_codex_entry` で children を取得)。",

  headers: {
    projectInfo: "\n## プロジェクト情報",
    previousScene: "\n## 直前のシーン",
    currentScene: "\n## 現在のシーン",
    sceneBody: "\n\n### シーン本文",
    referencingContent: "\n\n## 参照中のコンテンツ",
    codexSection: "\n## 登場キャラクター・設定情報",
    conversationSummary: "\n## これまでの会話の要約",
    commandInstruction: "\n## 指示",
    storySoFar: "## これまでの物語\n\n",
    /** L3: 現在シーンに紐づく伏線セクション。Synopsis / Pending Beats の後・
     * シーン本文の前に注入される。setup/payoff の両方を含む。 */
    sceneForeshadow: "\n\n### このシーンの伏線",
    /** L2: storySoFar 末尾に追記される未回収伏線セクション。projectId 全体から
     * payoffConfirmed=false かつ abandoned=false の伏線を loadBearing 優先度順に列挙。 */
    openForeshadows: "### 未回収の伏線",
    /** L3: storyTimePreviousScene 用ヘッダ。reading-order の `直前のシーン` と
     * 区別するため、ストーリー時系列で 1 つ前のシーンを別ブロックで注入する。
     * reading-order と一致する場合は注入しない。 */
    previousSceneStoryTime: "\n\n## 直前のシーン (ストーリー時系列)",
  },

  labels: {
    title: "タイトル",
    genre: "ジャンル",
    pov: "視点",
    tense: "時制",
    styleGuide: "文体ガイド",
    aiInstructions: "AI指示",
    synopsis: "あらすじ",
    prevTitle: "タイトル",
    prevSummary: "要約",
    contentType: "タイプ",
    contentTitle: "タイトル",
    contentBody: "内容",
    /** L4 Codex エントリの id ラベル。Agent が search_codex 往復なしで
     * get_codex_entry を呼べるよう、ヘッダ直下に UUID を露出させる。 */
    codexId: "id",
    /** L4 Codex エントリの aliases ラベル。別名で言及されたエントリを
     * Agent が再 fetch しないよう、注入時にカンマ区切りで露出する。 */
    codexAliases: "別名",
    /** L4 Codex エントリの tags ラベル。Spotlight エントリのみ注入。
     * Agent は `search_codex_by_tags` でこのタグを起点に同タグの他
     * エントリを発見できる。 */
    codexTags: "タグ",
    /** L4 Codex エントリの summary ラベル */
    codexSummary: "概要",
    /** L4 Codex エントリの fullContent ラベル。L3 シーン本文 (`本文:`) と
     * 衝突しないよう「全文」と区別する。 */
    codexFullContent: "全文",
    /** L3 sceneForeshadow セクションの「仕込み」行ラベル */
    foreshadowSetup: "仕込み",
    /** L3 sceneForeshadow セクションの「回収」行ラベル */
    foreshadowPayoff: "回収",
    /** L3 storyTimePreviousScene の時期ラベル（storyTimeLabel が設定されている場合のみ） */
    storyTimeLabel: "時期",
    /** L2 openForeshadows の loadBearing 表記（critical/supporting/optional/unspecified） */
    foreshadowCritical: "重要度: critical",
    foreshadowSupporting: "重要度: supporting",
    foreshadowOptional: "重要度: optional",
  },

  typeLabels: JA_TYPE_LABELS,

  trimMarkers: {
    l1: JA_L1_TRIM_MARKERS,
    l3: JA_L3_TRIM_MARKERS,
  },
};
