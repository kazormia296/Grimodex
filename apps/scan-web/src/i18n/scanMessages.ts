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
  account: {
    login: string;
    logout: string;
    checking: string;
    required: string;
  };
  demoFixture: string;
  running: string;
  policyLoading: string;
  ownershipRetained: string;
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
    owned: { label: string; title: string; description: string };
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
    viewPublicReport: string;
    publicReportNotice: string;
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
  publicReport: {
    eyebrow: string;
    loading: string;
    unavailable: string;
    projectionNotice: string;
    derivedLabelNotice: string;
    sourceCounts: (
      sections: number,
      paragraphs: number,
      characters: number,
    ) => string;
    genres: string;
    themes: string;
    entities: string;
    relations: string;
    phases: string;
    events: string;
    findings: string;
    untitledReport: string;
    genreLabel: (ordinal: number) => string;
    themeLabel: (ordinal: number) => string;
    entityLabel: (ordinal: number) => string;
    relationLabel: string;
    phaseLabel: (ordinal: number) => string;
    eventLabel: (ordinal: number) => string;
    findingLabel: (ordinal: number) => string;
    abuseTitle: string;
    abuseReason: string;
    abusePlaceholder: string;
    abuseCaveat: string;
    abuseSubmit: string;
    abuseSubmitting: string;
    abuseSuccess: string;
    abuseError: string;
    cloudflareAbuse: string;
    backToScan: string;
  };
  deletion: {
    action: string;
    title: string;
    body: string;
    caveat: string;
    cancel: string;
    deleting: string;
    successCompleted: string;
    successPending: string;
    error: string;
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
  account: {
    login: "ログイン",
    logout: "ログアウト",
    checking: "アカウントを確認中…",
    required: "原稿のアップロードにはログインが必要です。",
  },
  demoFixture: "デモデータ（Scan API未設定）",
  running: "Scan実行中…",
  policyLoading: "データ利用ポリシーを確認中…",
  ownershipRetained:
    "別の原稿をScanするには、先に現在の原稿とScanデータを削除してください。",
  botVerificationRequired: "Scanの前にBot確認が必要です。",
  turnstileMissing: "Turnstileのサイトキーが設定されていません。",
  publishConfirmation:
    "公開に必要な権利があり、個人情報の暴露や権利侵害がないことを確認しましたか？原稿本文と根拠、非公開メタデータは公開しませんが、作品名や短い原稿由来ラベルは表示されます。閲覧者は問題を通報できます。このレポートを公開しますか？",
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
    owned: {
      label: "データ管理",
      title: "前回のScanデータが残っています",
      description:
        "このタブに保持した削除資格情報を使って、原稿とScanデータを削除できます。",
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
    viewPublicReport: "公開レポートを表示",
    publicReportNotice:
      "本文と根拠は公開されません。作品名や短い原稿由来ラベルは表示され、閲覧者は問題を通報できます。",
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
  publicReport: {
    eyebrow: "Grimodex Scan · 公開レポート",
    loading: "公開レポートを読み込んでいます…",
    unavailable:
      "この公開レポートを取得できません。公開が停止されたか、URLが正しくない可能性があります。",
    projectionNotice: "原稿本文・根拠・非公開メタデータは表示されません。",
    derivedLabelNotice:
      "作品名、登場要素などの短い派生ラベルには原稿由来情報が含まれる場合があります。",
    sourceCounts: (sections, paragraphs, characters) =>
      `${characters.toLocaleString("ja-JP")}文字 · ${sections}章 · ${paragraphs}段落`,
    genres: "ジャンル候補",
    themes: "テーマ",
    entities: "登場要素",
    relations: "関係",
    phases: "物語Phase",
    events: "イベント",
    findings: "指摘",
    untitledReport: "無題のScanレポート",
    genreLabel: (ordinal) => `ジャンル ${ordinal}`,
    themeLabel: (ordinal) => `テーマ ${ordinal}`,
    entityLabel: (ordinal) => `登場要素 ${ordinal}`,
    relationLabel: "関係",
    phaseLabel: (ordinal) => `フェーズ ${ordinal}`,
    eventLabel: (ordinal) => `イベント ${ordinal}`,
    findingLabel: (ordinal) => `指摘 ${ordinal}`,
    abuseTitle: "この公開レポートを通報",
    abuseReason: "通報理由",
    abusePlaceholder:
      "権利侵害、個人情報、違法・有害な内容などを具体的に記載してください",
    abuseCaveat:
      "通報理由には原稿本文や不要な個人情報を貼り付けないでください。送信内容は運営者の確認対象として記録されます。",
    abuseSubmit: "通報を送信",
    abuseSubmitting: "送信中…",
    abuseSuccess: "通報を受け付けました。運営者の確認対象として記録しました。",
    abuseError:
      "通報を送信できませんでした。時間をおいて、もう一度お試しください。",
    cloudflareAbuse: "Cloudflareへ正式に報告",
    backToScan: "Scanへ戻る",
  },
  deletion: {
    action: "原稿とScanデータを削除",
    title: "原稿とScanデータを削除しますか？",
    body: "実行中のScanを停止し、Grimodexに保存された原稿、非公開の解析結果、Editor引き継ぎ用データを削除します。公開レポートは非公開になります。この操作は取り消せません。",
    caveat:
      "本文を含まないファイル情報・運用メタデータ、同意・利用記録、ハッシュ、セキュリティ／不正利用防止記録は、運用上または法的な保持要件に従って残る場合があります。AI処理基盤へ送信済みのデータには各プロバイダの保持方針が適用されます。すでにWeb EditorやローカルGrimodexへ取り込んだコピーは削除されません。",
    cancel: "キャンセル",
    deleting: "削除中…",
    successCompleted:
      "原稿とScanデータを削除しました。公開レポートと今後のEditor引き継ぎも利用できません。",
    successPending:
      "削除を受け付けました。アクセスは停止済みです。保存ファイルの削除はバックグラウンドで継続します。",
    error:
      "削除結果を確認できませんでした。アクセスが停止していない可能性があります。接続を確認して、もう一度お試しください。",
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
  account: {
    login: "Log in",
    logout: "Log out",
    checking: "Checking your account…",
    required: "Log in to upload a manuscript.",
  },
  demoFixture: "Demo data (Scan API not configured)",
  running: "Scan in progress…",
  policyLoading: "Loading the data policy…",
  ownershipRetained:
    "Delete the current manuscript and Scan data before scanning another manuscript.",
  botVerificationRequired: "Bot verification is required before scanning.",
  turnstileMissing: "The Turnstile site key is not configured.",
  publishConfirmation:
    "Do you have the rights required to publish, and have you checked that the report does not expose personal data or infringe others’ rights? Manuscript text, evidence, and private metadata are omitted, but the title and short manuscript-derived labels are shown. Viewers can report problems. Publish this report?",
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
    owned: {
      label: "Data management",
      title: "Data from your previous Scan remains",
      description:
        "Use the deletion capability retained in this tab to delete the manuscript and Scan data.",
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
    viewPublicReport: "View public report",
    publicReportNotice:
      "Manuscript text and evidence are not published. The title and short manuscript-derived labels are shown, and viewers can report problems.",
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
  publicReport: {
    eyebrow: "Grimodex Scan · Public report",
    loading: "Loading the public report…",
    unavailable:
      "This public report could not be retrieved. Publishing may have stopped, or the URL may be invalid.",
    projectionNotice:
      "Manuscript text, evidence, and private metadata are not shown.",
    derivedLabelNotice:
      "The title and short derived labels such as entity names may still contain manuscript-derived information.",
    sourceCounts: (sections, paragraphs, characters) =>
      `${characters.toLocaleString("en-US")} characters · ${sections} sections · ${paragraphs} paragraphs`,
    genres: "Genre candidates",
    themes: "Themes",
    entities: "Entities",
    relations: "Relationships",
    phases: "Story phases",
    events: "Events",
    findings: "Findings",
    untitledReport: "Untitled Scan report",
    genreLabel: (ordinal) => `Genre ${ordinal}`,
    themeLabel: (ordinal) => `Theme ${ordinal}`,
    entityLabel: (ordinal) => `Entity ${ordinal}`,
    relationLabel: "related",
    phaseLabel: (ordinal) => `Phase ${ordinal}`,
    eventLabel: (ordinal) => `Event ${ordinal}`,
    findingLabel: (ordinal) => `Finding ${ordinal}`,
    abuseTitle: "Report this public report",
    abuseReason: "Reason for report",
    abusePlaceholder:
      "Describe possible infringement, personal data exposure, or unlawful or harmful content",
    abuseCaveat:
      "Do not paste manuscript text or unnecessary personal data into the reason. Your submission is recorded for operator review.",
    abuseSubmit: "Submit report",
    abuseSubmitting: "Submitting…",
    abuseSuccess: "Your report was accepted and recorded for operator review.",
    abuseError:
      "The report could not be submitted. Wait a moment and try again.",
    cloudflareAbuse: "Report formally to Cloudflare",
    backToScan: "Back to Scan",
  },
  deletion: {
    action: "Delete manuscript and Scan data",
    title: "Delete the manuscript and Scan data?",
    body: "This stops any in-progress Scan, deletes the manuscript, private analysis results, and Editor handoff data stored by Grimodex, and unpublishes any public report. This cannot be undone.",
    caveat:
      "Content-free file and operational metadata, consent and usage records, hashes, and security or abuse-prevention records may remain subject to operational or legal retention requirements. Data already sent to a processing provider remains subject to that provider’s retention policy. Copies already imported into Web Editor or local Grimodex are not deleted.",
    cancel: "Cancel",
    deleting: "Deleting…",
    successCompleted:
      "The manuscript and Scan data were deleted. The public report and future Editor handoff are no longer available.",
    successPending:
      "The deletion request was accepted. Access has been revoked, and stored files will continue to be removed in the background.",
    error:
      "Scan could not confirm the deletion result. Access may still be active. Check your connection and try again.",
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
