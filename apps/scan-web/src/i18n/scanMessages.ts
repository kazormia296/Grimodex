import type { ScanEntityType } from "@grimodex/scan-contract";
import type { ScanLocale } from "./scanLocale";

export interface ScanMessages {
  productsNavigation: string;
  openStandaloneEditor: string;
  workflow: string;
  interfaceLanguage: string;
  interfaceAuto: string;
  interfaceJapanese: string;
  interfaceEnglish: string;
  writingLanguage: string;
  writingAuto: string;
  writingJapanese: string;
  writingEnglish: string;
  scanMode: string;
  quickMode: string;
  fullMode: string;
  upload: string;
  demoFixture: string;
  running: string;
  policyLoading: string;
  botVerificationRequired: string;
  turnstileMissing: string;
  publishConfirmation: string;
  errors: {
    network: string;
    unavailable: string;
    rateLimited: string;
    invalidSource: string;
    unauthorized: string;
    generic: string;
  };
  state: {
    running: { label: string; title: string; description: string };
    error: { label: string; title: string; description: string };
    idle: { label: string; title: string; description: string };
  };
  report: {
    demo: string;
    private: string;
    demoDescription: string;
    writingLanguage: string;
    detected: string;
    selected: string;
    japanese: string;
    english: string;
    other: string;
    overview: string;
    entities: string;
    relations: string;
    phases: string;
    findings: string;
    aliases: string;
    edit: string;
    preparingEditor: string;
    publish: string;
    publishing: string;
    unpublish: string;
    updating: string;
    publicReportId: string;
    evidence: string;
    evidenceParagraphs: string;
    intentional: string;
    rejected: string;
    statuses: Record<
      "candidate" | "confirmed" | "rejected" | "intentional",
      string
    >;
    entityTypes: Record<ScanEntityType, string>;
  };
  consent: {
    eyebrow: string;
    title: string;
    sentData: string;
    destinations: string;
    storage: string;
    providerStorage: string;
    providerRetention: string;
    training: string;
    retentionSummary: (
      uploadMinutes: number,
      sourceDays: number,
      artifactDays: number,
    ) => string;
    confirm: string;
    decline: string;
    accept: string;
    grimodexPolicy: string;
    destinationPolicy: (processor: string) => string;
    storagePolicy: string;
    retentionPolicy: string;
    trainingPolicy: string;
  };
  turnstileLabel: string;
}

const ja: ScanMessages = {
  productsNavigation: "Grimodex 製品",
  openStandaloneEditor: "Editorを単体で開く",
  workflow: "Scan ワークフロー",
  interfaceLanguage: "表示言語",
  interfaceAuto: "自動（ブラウザー）",
  interfaceJapanese: "日本語",
  interfaceEnglish: "English",
  writingLanguage: "執筆言語",
  writingAuto: "自動判定",
  writingJapanese: "日本語",
  writingEnglish: "英語",
  scanMode: "Scanモード",
  quickMode: "Quick",
  fullMode: "Full",
  upload: ".txt / .md をアップロード",
  demoFixture: "デモデータ（Scan API未設定）",
  running: "Scan実行中…",
  policyLoading: "データ利用ポリシーを確認中…",
  botVerificationRequired: "Scanの前にBot確認が必要です。",
  turnstileMissing: "Turnstileのサイトキーが設定されていません。",
  publishConfirmation:
    "本文の根拠と非公開メタデータを除いたレポートを公開しますか？",
  errors: {
    network:
      "Scanサービスと通信できませんでした。接続を確認して、もう一度お試しください。",
    unavailable:
      "Scanサービスは一時的に利用できません。時間をおいて、もう一度お試しください。",
    rateLimited:
      "Scanサービスが混み合っています。少し待ってから、もう一度お試しください。",
    invalidSource:
      "この原稿を受け付けられませんでした。ファイルの形式とサイズを確認してください。",
    unauthorized:
      "Scanの認証情報を確認できませんでした。ページを再読み込みして、もう一度お試しください。",
    generic:
      "Scanの処理を完了できませんでした。時間をおいて、もう一度お試しください。",
  },
  state: {
    running: {
      label: "解析中",
      title: "原稿を解析しています…",
      description: "解析が完了するまで、この画面を開いたままお待ちください。",
    },
    error: {
      label: "エラー",
      title: "Scanを完了できませんでした",
      description:
        "解析結果は作成されていません。内容を確認して、もう一度お試しください。",
    },
    idle: {
      label: "準備完了",
      title: "原稿をアップロードしてください",
      description:
        "まだ解析結果はありません。.txt または .md の原稿を選ぶとScanを開始できます。",
    },
  },
  report: {
    demo: "デモレポート",
    private: "非公開レポート",
    demoDescription:
      "操作確認用のサンプルです。実際の原稿を解析した結果ではありません。",
    writingLanguage: "執筆言語",
    detected: "自動判定",
    selected: "手動指定",
    japanese: "日本語",
    english: "英語",
    other: "その他",
    overview: "概要",
    entities: "登場人物・舞台",
    relations: "関係",
    phases: "物語のPhase候補",
    findings: "設定・時系列の指摘",
    aliases: "別名",
    edit: "この作品を編集する",
    preparingEditor: "Editorを準備中…",
    publish: "公開レポートを作成",
    publishing: "公開処理中…",
    unpublish: "公開を停止",
    updating: "更新中…",
    publicReportId: "公開レポートID",
    evidence: "根拠",
    evidenceParagraphs: "根拠段落",
    intentional: "意図的として扱う",
    rejected: "誤りとして扱う",
    statuses: {
      candidate: "要確認",
      confirmed: "確認済み",
      rejected: "誤り",
      intentional: "意図的",
    },
    entityTypes: {
      character: "人物",
      place: "場所",
      organization: "組織",
      object: "物品",
      alias: "別名",
      unknown: "未分類",
    },
  },
  consent: {
    eyebrow: "Grimodex Scan · データポリシー",
    title: "原稿をアップロードする前に確認",
    sentData: "処理のために送信されるデータ",
    destinations: "処理先と地域",
    storage: "保存先と保持期間",
    providerStorage: "処理基盤側の保存",
    providerRetention: "処理基盤側の保持期間",
    training: "モデル学習への利用",
    retentionSummary: (uploadMinutes, sourceDays, artifactDays) =>
      `アップロード枠 ${uploadMinutes}分 / 原稿 ${sourceDays}日 / 解析結果 ${artifactDays}日`,
    confirm: "上記の送信・保存・学習利用方針を確認しました",
    decline: "今はScanしない",
    accept: "同意してScanを開始",
    grimodexPolicy: "Grimodex プライバシー通知",
    destinationPolicy: (processor) => `${processor} のデータ利用ポリシー`,
    storagePolicy: "処理基盤の保存ポリシー",
    retentionPolicy: "処理基盤の保持ポリシー",
    trainingPolicy: "モデル学習へのデータ利用ポリシー",
  },
  turnstileLabel: "Bot確認",
};

const en: ScanMessages = {
  productsNavigation: "Grimodex products",
  openStandaloneEditor: "Open Editor on its own",
  workflow: "Scan workflow",
  interfaceLanguage: "Interface language",
  interfaceAuto: "Automatic (browser)",
  interfaceJapanese: "日本語",
  interfaceEnglish: "English",
  writingLanguage: "Writing language",
  writingAuto: "Detect automatically",
  writingJapanese: "Japanese",
  writingEnglish: "English",
  scanMode: "Scan mode",
  quickMode: "Quick",
  fullMode: "Full",
  upload: "Upload .txt / .md",
  demoFixture: "Demo data (Scan API not configured)",
  running: "Scan in progress…",
  policyLoading: "Loading the data policy…",
  botVerificationRequired: "Bot verification is required before scanning.",
  turnstileMissing: "The Turnstile site key is not configured.",
  publishConfirmation:
    "Publish a report with manuscript evidence and private metadata removed?",
  errors: {
    network:
      "Scan could not connect to the service. Check your connection and try again.",
    unavailable:
      "Scan is temporarily unavailable. Wait a moment and try again.",
    rateLimited:
      "Scan is receiving too many requests. Wait a moment and try again.",
    invalidSource:
      "Scan could not accept this manuscript. Check the file format and size.",
    unauthorized:
      "Scan could not verify your authorization. Reload the page and try again.",
    generic:
      "Scan could not complete the request. Wait a moment and try again.",
  },
  state: {
    running: {
      label: "Analyzing",
      title: "Analyzing your manuscript…",
      description: "Keep this page open until the analysis is complete.",
    },
    error: {
      label: "Error",
      title: "Scan could not be completed",
      description: "No report was created. Check the details and try again.",
    },
    idle: {
      label: "Ready",
      title: "Upload your manuscript",
      description:
        "There is no report yet. Choose a .txt or .md manuscript to start Scan.",
    },
  },
  report: {
    demo: "Demo report",
    private: "Private report",
    demoDescription:
      "This sample is for trying the interface and is not an analysis of your manuscript.",
    writingLanguage: "Writing language",
    detected: "detected",
    selected: "selected",
    japanese: "Japanese",
    english: "English",
    other: "Other",
    overview: "Overview",
    entities: "Characters & places",
    relations: "Relationships",
    phases: "Story phases",
    findings: "Continuity & timeline findings",
    aliases: "Aliases",
    edit: "Edit this work",
    preparingEditor: "Preparing Editor…",
    publish: "Create public report",
    publishing: "Publishing…",
    unpublish: "Stop publishing",
    updating: "Updating…",
    publicReportId: "Public report ID",
    evidence: "Evidence",
    evidenceParagraphs: "Evidence paragraphs",
    intentional: "Mark as intentional",
    rejected: "Mark as incorrect",
    statuses: {
      candidate: "Review",
      confirmed: "Confirmed",
      rejected: "Incorrect",
      intentional: "Intentional",
    },
    entityTypes: {
      character: "Character",
      place: "Place",
      organization: "Organization",
      object: "Object",
      alias: "Alias",
      unknown: "Unclassified",
    },
  },
  consent: {
    eyebrow: "Grimodex Scan · Data policy",
    title: "Review before uploading",
    sentData: "Data sent for processing",
    destinations: "Processing destinations and regions",
    storage: "Storage and retention",
    providerStorage: "Processing service storage",
    providerRetention: "Processing service retention",
    training: "Use for model training",
    retentionSummary: (uploadMinutes, sourceDays, artifactDays) =>
      `Upload slot ${uploadMinutes} min / manuscript ${sourceDays} days / results ${artifactDays} days`,
    confirm:
      "I have reviewed the data transfer, storage, and model-training terms above",
    decline: "Not now",
    accept: "Agree and start Scan",
    grimodexPolicy: "Grimodex Privacy Notice",
    destinationPolicy: (processor) => `${processor} data usage policy`,
    storagePolicy: "Processing service storage policy",
    retentionPolicy: "Processing service retention policy",
    trainingPolicy: "Model-training data usage policy",
  },
  turnstileLabel: "Bot verification",
};

export const SCAN_MESSAGES: Record<ScanLocale, ScanMessages> = { ja, en };

export function scanMessages(locale: ScanLocale): ScanMessages {
  return SCAN_MESSAGES[locale];
}
