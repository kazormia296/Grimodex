import i18next from "@/lib/i18n";

/**
 * The strings of the Scene body declaration UI (CB-3), keyed under
 * `editor.sceneDetail.bodyDeclaration`.
 *
 * They live in the lazy chunk of the section rather than in `src/locales/*.json`
 * so that, while `BODY_DECLARATION_UI_ENABLED` is false, they are not part of
 * the startup JS graph (DR-CB3-35). The same pattern as
 * `src/locales/liveReader.ts`.
 */
export const BODY_DECLARATION_TRANSLATIONS = {
  ja: {
    title: "本文の開示宣言",
    scopeNote:
      "宣言の対象は、保存された本文の全体と title です。未配置のビート（unplaced beats）とメモは含まれません。",
    invalidationNote:
      "この Scene の Scope（A1）や registry を保存すると、宣言は失効します。registry の変更は project のすべての Scene の宣言に影響します。",
    state: {
      loading: "読み込み中",
      unknown: "不明",
      restartRequired: "再起動が必要",
      draft: "草案（未宣言）",
      effective: "宣言済み・現在有効",
      expired: "宣言済み・失効",
      paused: "宣言済み・止まっている",
      unavailable: "宣言済み・読めない",
    },
    loading: "宣言の状態を読み込んでいます…",
    unknownRead: "宣言の状態を読めませんでした。有効とは見なされません。",
    reload: "再読込",
    restartRequired:
      "Grimodex を再起動するまで、宣言も取消もできません。再起動してください。",
    draftIntro:
      "まだ宣言されていません。この Scene の本文全体を、Graph が追加する Scene として表示してよいと宣言するには、次の 5 項目を 1 つずつ確認してください。",
    axesLegend: "宣言する内容（1 つずつ確認）",
    axis: {
      story: {
        label: "story（物語上の時間）",
        help: "story time の前後に限られず、本文全体を表示してよい（independent）",
      },
      auto: {
        label: "auto（読む順の判定）",
        help: "読む順と story time による phase の判定に限られず表示してよい（independent）",
      },
      phase: {
        label: "phase（Codex の phase）",
        help: "Codex の phase に限られず表示してよい（independent）",
      },
      reveal: {
        label: "reveal（秘密）",
        help: "本文全体に、まだ明かしていない秘密を含まない（non-secret）",
      },
      pov: {
        label: "POV（視点）",
        help: "視点に限られた知識を含まず、どの視点の query にも表示してよい（independent）",
      },
    },
    axesPending: "5 項目をすべて確認すると宣言できます。",
    declare: "宣言する",
    redeclare: "改めて宣言する",
    declareHint:
      "押すと Grimodex 本体の確認ダイアログが開きます。宣言は、そのダイアログで承認したときだけ行われます。",
    declaring:
      "Grimodex 本体の確認ダイアログを待っています。この間、ほかの保存が待たされることがあります。",
    unsavedWait:
      "本文・title・あらすじに未保存の編集があります。保存を待ってください。保存された内容が宣言の対象になります。",
    blockerPrefix: "いまは宣言できません。",
    effectiveHeading: "この Scene は現在有効です。",
    effectiveBody:
      "Graph が見つけたときだけ、この Scene は Related Scenes に表示されえます。表示は保証されません。",
    effectiveExpiresOn:
      "本文・title・Scope（A1）・registry・章の組み替え・restore で、宣言は失効します。workspace の移動や、秘密の伏線・Chronicle event の記録を足すことでは、宣言は止まります。失効したときも止まったときも、この画面でお知らせします。",
    expiredHeading: "宣言が失効しました。",
    expiredPrompt:
      "失効した宣言は使われません。この Scene を開示に使うには、内容を確認して改めて宣言してください。",
    pausedHeading: "宣言は止まっています。",
    pausedBody:
      "いまは使われません。上の原因が解消し、本文・title・Scope（A1）などが宣言したときのままであれば、この宣言は再び有効になります。止めたいときは取り消してください。",
    noticeGone:
      "宣言がなくなりました（別の窓での取消や restore など）。この Scene は開示に使われません。",
    expiredUnknown: "宣言は現在有効ではありません。",
    expiry: {
      content: "本文または title が変わりました。",
      scope:
        "Scope（A1）、registry、章の組み替えなど、Scope に関わる設定が変わりました。",
      identity:
        "Scene の同一性が変わりました（複製・削除と再作成・ごみ箱からの復元など）。",
      workspace: "workspace が変わりました（場所の移動・複写など）。",
    },
    unavailableHeading:
      "保存された宣言を読めません。有効な宣言とは見なされません。",
    unavailable: {
      "binding-row-missing": "宣言の保存先が見つかりません。",
      "half-state": "宣言の記録が片方しか残っていません。",
      oversized: "宣言の記録が大きすぎて読めません。",
      malformed: "宣言の記録が壊れています。",
      "unsupported-version": "宣言の記録の版に対応していません。",
      "unknown-field": "宣言の記録に未知の項目があります。",
      "token-mismatch": "宣言の記録が一致しません。",
      "scene-key-mismatch": "宣言の記録がこの Scene のものと一致しません。",
      "unknown-response": "宣言の状態の応答を認識できませんでした。",
    },
    revoke: "宣言を取り消す",
    revoking: "取り消しています…",
    revokeHint: "取消は確認なしで行われ、すぐに開示を止めます。",
    outcome: {
      declared: "宣言しました。",
      declareRefused: "宣言されませんでした。{{reason}}",
      revoked: "宣言を取り消しました。",
      "no-declaration": "取り消す宣言はありませんでした。",
      "declaration-changed":
        "宣言が画面の表示と違っていたため、何も取り消していません。最新の状態を読み直しました。",
      revokeRefused: "取り消せませんでした。{{reason}}",
    },
    code: {
      "scene-not-found": "この Scene が見つかりません。",
      "scene-archived": "アーカイブされた Scene は宣言できません。",
      "scope-unavailable": "Scope（A1）を読めません。",
      "scope-not-explicit":
        "Scope（A1）が明示されていません。Scope を明示して保存すると宣言できます。",
      "scope-unresolved":
        "Scope（A1）に未解決の項目があります。解決して保存すると宣言できます。",
      "body-empty": "本文が空です。",
      "body-too-large": "本文が大きすぎます。",
      "body-unreadable": "保存された本文を読めません。",
      "title-too-large": "title が長すぎます。",
      "locator-unavailable": "この workspace の場所を確定できません。",
      "veto-secret-foreshadow":
        "この Scene を参照する秘密の伏線（foreshadow）の記録があります。",
      "veto-secret-event-reveal":
        "この Scene で明かされる秘密の Chronicle event の記録があります。",
      "veto-secret-event-link":
        "この Scene に結ばれた秘密の Chronicle event の記録があります。",
      "veto-pov": "視点（POV）の記録があります。",
      "veto-limit": "確認すべき記録が多すぎて、宣言できるか判断できません。",
      "declaration-unreadable": "保存された宣言を読めません。",
      "gate-closed": "この機能は現在利用できません。",
      "restart-required": "再起動が必要です。Grimodex を再起動してください。",
      "workspace-mismatch": "開いている workspace と一致しません。",
      "invalid-request": "要求が正しくありません。",
      "state-changed":
        "Scene の状態が途中で変わりました。最新の状態を読み直したので、確認してからもう一度行ってください。",
      "display-mismatch":
        "確認ダイアログの内容と Scene の状態が一致しませんでした。",
      "request-conflict": "同じ要求が重複しました。",
      "commit-failed":
        "保存の結果を確認できませんでした。最新の状態を読み直しています。",
      internal: "内部エラーが発生しました。",
      "store-failure":
        "保存先が混み合っているか、一時的に使えません。しばらくしてからもう一度試してください。",
      "grant-cancelled": "確認ダイアログがキャンセルされました。",
      "grant-expired": "確認ダイアログの期限が切れました。",
      "grant-revoked": "確認が取り消されました。",
      "grant-busy":
        "ほかの確認ダイアログが開いています。終えてからもう一度試してください。",
      "grant-required": "確認の経路が使えません。",
      "grant-sender-unavailable": "確認ダイアログを開けませんでした。",
      "grant-failed": "確認を完了できませんでした。",
      "egress-denied": "この操作は許可されていません。",
      timeout: "応答がありませんでした。最新の状態を読み直してください。",
      "unknown-refusal": "原因を特定できませんでした。",
    },
  },
  en: {
    title: "Scene body disclosure",
    scopeNote:
      "The declaration covers the saved body and the title as a whole. Unplaced beats and notes are not included.",
    invalidationNote:
      "Saving this Scene's Scope (A1) or the registry expires the declaration. A registry change affects the declarations of every Scene in the project.",
    state: {
      loading: "Loading",
      unknown: "Unknown",
      restartRequired: "Restart required",
      draft: "Draft (not declared)",
      effective: "Declared, currently effective",
      expired: "Declared, expired",
      paused: "Declared, paused",
      unavailable: "Declared, unreadable",
    },
    loading: "Reading the declaration state…",
    unknownRead:
      "The declaration state could not be read. It is not treated as effective.",
    reload: "Reload",
    restartRequired:
      "Declaring and revoking are unavailable until Grimodex is restarted. Please restart.",
    draftIntro:
      "Not declared yet. To declare that the whole body of this Scene may be shown as a Scene that Graph adds, confirm each of the five items below.",
    axesLegend: "What you declare (confirm each one)",
    axis: {
      story: {
        label: "story (story time)",
        help: "The whole body may be shown regardless of story time (independent)",
      },
      auto: {
        label: "auto (reading order)",
        help: "May be shown regardless of how reading order and story time resolve the phase (independent)",
      },
      phase: {
        label: "phase (Codex phase)",
        help: "May be shown regardless of the Codex phase (independent)",
      },
      reveal: {
        label: "reveal (secrets)",
        help: "The whole body contains no secret that has not been revealed yet (non-secret)",
      },
      pov: {
        label: "POV (viewpoint)",
        help: "Contains no knowledge limited to a viewpoint; may be shown to a query from any viewpoint (independent)",
      },
    },
    axesPending: "Confirm all five items to declare.",
    declare: "Declare",
    redeclare: "Declare again",
    declareHint:
      "A confirmation dialog of Grimodex itself opens when you press this. The declaration is made only if you approve it in that dialog.",
    declaring:
      "Waiting for the confirmation dialog of Grimodex itself. Other saves may wait meanwhile.",
    unsavedWait:
      "The body, title or synopsis has unsaved edits. Wait for them to be saved; the saved content is what the declaration covers.",
    blockerPrefix: "Declaring is not possible right now.",
    effectiveHeading: "This Scene is currently effective.",
    effectiveBody:
      "Only when Graph finds it can this Scene appear in Related Scenes. Display is not guaranteed.",
    effectiveExpiresOn:
      "The declaration expires when the body, title, Scope (A1), registry, chapter arrangement or a restore changes. A workspace move, or adding a secret foreshadow or Chronicle event record, pauses it. This panel tells you when it expires or is paused.",
    expiredHeading: "The declaration has expired.",
    expiredPrompt:
      "An expired declaration is not used. To use this Scene for disclosure, review it and declare again.",
    pausedHeading: "The declaration is paused.",
    pausedBody:
      "It is not used right now. If the cause above is resolved and the body, title and Scope (A1) are still as when you declared, the declaration becomes effective again. To stop it, revoke it.",
    noticeGone:
      "The declaration is gone (revoked in another window, cleared by a restore and so on). This Scene is not used for disclosure.",
    expiredUnknown: "The declaration is not currently effective.",
    expiry: {
      content: "The body or title changed.",
      scope:
        "A Scope setting changed (Scope (A1), registry, chapter arrangement and so on).",
      identity:
        "The identity of the Scene changed (duplicated, deleted and recreated, restored from the trash and so on).",
      workspace: "The workspace changed (moved, copied and so on).",
    },
    unavailableHeading:
      "The stored declaration cannot be read. It is not treated as effective.",
    unavailable: {
      "binding-row-missing":
        "The place that stores the declaration was not found.",
      "half-state": "Only half of the declaration record remains.",
      oversized: "The declaration record is too large to read.",
      malformed: "The declaration record is damaged.",
      "unsupported-version":
        "The version of the declaration record is not supported.",
      "unknown-field": "The declaration record has an unknown field.",
      "token-mismatch": "The declaration record does not match.",
      "scene-key-mismatch":
        "The declaration record does not belong to this Scene.",
      "unknown-response":
        "The answer about the declaration state was not recognised.",
    },
    revoke: "Revoke declaration",
    revoking: "Revoking…",
    revokeHint: "Revoking needs no confirmation and stops disclosure at once.",
    outcome: {
      declared: "Declared.",
      declareRefused: "Not declared. {{reason}}",
      revoked: "The declaration was revoked.",
      "no-declaration": "There was no declaration to revoke.",
      "declaration-changed":
        "The declaration differed from what was shown, so nothing was revoked. The latest state has been read again.",
      revokeRefused: "Could not revoke. {{reason}}",
    },
    code: {
      "scene-not-found": "This Scene was not found.",
      "scene-archived": "An archived Scene cannot be declared.",
      "scope-unavailable": "Scope (A1) cannot be read.",
      "scope-not-explicit":
        "Scope (A1) is not explicit. Make it explicit and save to declare.",
      "scope-unresolved":
        "Scope (A1) has unresolved items. Resolve them and save to declare.",
      "body-empty": "The body is empty.",
      "body-too-large": "The body is too large.",
      "body-unreadable": "The saved body cannot be read.",
      "title-too-large": "The title is too long.",
      "locator-unavailable":
        "The location of this workspace cannot be determined.",
      "veto-secret-foreshadow": "A secret foreshadow refers to this Scene.",
      "veto-secret-event-reveal":
        "A secret Chronicle event is revealed in this Scene.",
      "veto-secret-event-link":
        "A secret Chronicle event is linked to this Scene.",
      "veto-pov": "A viewpoint (POV) is recorded.",
      "veto-limit":
        "There are too many records to check, so it cannot be decided whether this Scene can be declared.",
      "declaration-unreadable": "The stored declaration cannot be read.",
      "gate-closed": "This feature is not available now.",
      "restart-required": "A restart is required. Please restart Grimodex.",
      "workspace-mismatch": "It does not match the open workspace.",
      "invalid-request": "The request is not valid.",
      "state-changed":
        "The Scene changed meanwhile. The latest state was read again; review it and try again.",
      "display-mismatch":
        "The confirmation dialog did not match the state of the Scene.",
      "request-conflict": "The same request was repeated.",
      "commit-failed":
        "The result of saving could not be confirmed. Reading the latest state again.",
      internal: "An internal error occurred.",
      "store-failure":
        "The store is busy or temporarily unavailable. Try again in a moment.",
      "grant-cancelled": "The confirmation dialog was cancelled.",
      "grant-expired": "The confirmation dialog timed out.",
      "grant-revoked": "The confirmation was withdrawn.",
      "grant-busy":
        "Another confirmation dialog is open. Finish it and try again.",
      "grant-required": "The confirmation path is not available.",
      "grant-sender-unavailable":
        "The confirmation dialog could not be opened.",
      "grant-failed": "The confirmation could not be completed.",
      "egress-denied": "This operation is not allowed.",
      timeout: "There was no answer. Reload the latest state.",
      "unknown-refusal": "The cause could not be determined.",
    },
  },
} as const;

let installed = false;

/** Register the strings in both locales without replacing other resources. */
export function ensureBodyDeclarationTranslations(): void {
  if (installed) return;
  for (const [language, bodyDeclaration] of Object.entries(
    BODY_DECLARATION_TRANSLATIONS,
  )) {
    i18next.addResourceBundle(
      language,
      "translation",
      { editor: { sceneDetail: { bodyDeclaration } } },
      true,
      true,
    );
  }
  installed = true;
}
