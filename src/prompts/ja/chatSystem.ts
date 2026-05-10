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
    "そこにある情報で答えられる場合はツールを呼び出さないでください。" +
    "ツールは、事前注入されていないエントリの探索や、" +
    "注入された summary では足りない詳細の深掘りに限って使用してください。",

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
    /** L4 Codex エントリの summary ラベル */
    codexSummary: "概要",
    /** L4 Codex エントリの fullContent ラベル。L3 シーン本文 (`本文:`) と
     * 衝突しないよう「全文」と区別する。 */
    codexFullContent: "全文",
  },

  typeLabels: JA_TYPE_LABELS,

  trimMarkers: {
    l1: JA_L1_TRIM_MARKERS,
    l3: JA_L3_TRIM_MARKERS,
  },
};
