import i18next from "@/lib/i18n";

/**
 * The strings of the profile egress status display, the settings item, the
 * Related Scenes `profile-not-restricted` guidance (NIR-1 DA-2 ST3) and the
 * chat panel's closed entrances (DA-2b ST4-B, DR-DA2B-R6), keyed under
 * `profileEgress`.
 *
 * They live in the lazy chunks behind `PROFILE_ACTIVATION_UI_ENABLED` rather
 * than in `src/locales/*.json`, so that while the constant is false they are
 * not part of the startup JS graph (DR-DA2-30; the pattern of
 * `bodyDeclarationTranslations.ts`, DR-CB3-35).
 *
 * Draft wording: these strings and Native's disclosure text are approved
 * together in Session C-1 (D-13 (a)). They state only what the closed codes
 * say; the binding disclosure is the text of Main's confirmation dialog, which
 * comes from Native.
 */
export const PROFILE_EGRESS_TRANSLATIONS = {
  ja: {
    status: {
      restricted: "外部送信を制限中",
      restrictedDetail:
        "この profile は外部への送信を制限しています。制限は解除できません。",
      activating: "外部送信の制限を有効にしています…",
      unavailableTitle: "外部送信の制限の状態を確かめられません",
      unavailableNote:
        "この状態の間は project を開けません。保存されたデータは消えません。",
    },
    reason: {
      "state-file-unreadable":
        "状態ファイル（userData の profile-egress.json）を読めません。ファイルを読めるようにしてから、Grimodex を再起動してください。",
      "state-file-unwritable":
        "状態ファイル（userData の profile-egress.json）に書き込めませんでした。userData に書き込めるようにしてから、Grimodex を再起動してください。再起動の後は、外部送信の制限を有効にする処理が成立していれば制限中、成立していなければ制限なしになります。",
      "barrier-timeout":
        "実行中の処理が止まったことを時間内に確かめられませんでした。Grimodex を再起動してください。再起動の後にもう一度確かめます。",
      "activation-failed":
        "外部送信の制限を有効にする処理が失敗しました。Grimodex を再起動してください。",
      "participant-timeout":
        "外部の AI ツールや書出しの処理が時間内に止まりませんでした。Grimodex を再起動してください。",
      "participant-failed":
        "外部の AI ツールや書出しの処理を止められませんでした。Grimodex を再起動してください。",
      "backend-unavailable":
        "データの処理を始められませんでした。Grimodex を再起動してください。",
      "status-invalid":
        "外部送信の制限の状態が正しくありません。Grimodex を再起動してください。",
    },
    settings: {
      title: "外部送信の制限",
      description:
        "この profile で外部への送信を止めます。一度有効にすると元に戻せません。有効にする前に、確認の画面で内容を確かめてください。",
      stateLabel: "状態",
      state: {
        loading: "読み込み中",
        unknown: "不明",
        unrestricted: "無効",
        activating: "有効にしています…",
        restricted: "有効（解除できません）",
        unavailable: "確かめられません",
      },
      request: "外部送信の制限を有効にする…",
      requesting: "確認の画面を表示しています…",
    },
    guidance: {
      graphNeedsRestriction:
        "Graph の関連は、外部送信の制限を有効にした profile でだけ使えます。",
    },
    chat: {
      aiClosed:
        "外部送信を制限中のため、AI の応答は使えません。場面の会話への入力は保存されます。",
      sendClosed:
        "外部送信を制限中は、場面の会話でない会話に入力を保存できません。",
      editClosed:
        "外部送信を制限中は、場面の会話でない会話のメッセージを編集して送り直せません。削除はできます。",
    },
    import: {
      chatsRestricted:
        "外部送信を制限中は会話を取り込めないため、会話 {{count}} 件は取り込みませんでした。",
    },
    result: {
      activated: "外部送信の制限を有効にしました。",
      cancelled: "取り消しました。外部送信の制限は変わっていません。",
      expired: "確認の期限が切れました。もう一度操作してください。",
      busy: "ほかの処理が進行中です。しばらくしてからもう一度操作してください。",
      "already-restricted": "外部送信の制限は既に有効です。",
      unavailable: "いまは外部送信の制限を有効にできません。",
      "not-activated": "この版では、まだ外部送信の制限を有効にできません。",
      refused: "要求を受け付けられませんでした。",
    },
  },
  en: {
    status: {
      restricted: "External sending restricted",
      restrictedDetail:
        "This profile restricts sending to external services. The restriction cannot be removed.",
      activating: "Turning on the external sending restriction…",
      unavailableTitle: "The external sending restriction could not be checked",
      unavailableNote:
        "Projects cannot be opened in this state. Saved data is not deleted.",
    },
    reason: {
      "state-file-unreadable":
        "The state file (profile-egress.json in userData) cannot be read. Make it readable, then restart Grimodex.",
      "state-file-unwritable":
        "The state file (profile-egress.json in userData) could not be written. Make userData writable, then restart Grimodex. After the restart, the external sending restriction is on if turning it on took effect, and off if it did not.",
      "barrier-timeout":
        "Grimodex could not confirm in time that running work stopped. Restart Grimodex; it checks again after the restart.",
      "activation-failed":
        "Turning on the external sending restriction failed. Restart Grimodex.",
      "participant-timeout":
        "External AI tools or the export process did not stop in time. Restart Grimodex.",
      "participant-failed":
        "External AI tools or the export process could not be stopped. Restart Grimodex.",
      "backend-unavailable":
        "The data layer could not start. Restart Grimodex.",
      "status-invalid":
        "The external sending restriction state is invalid. Restart Grimodex.",
    },
    settings: {
      title: "External sending restriction",
      description:
        "Stops sending to external services in this profile. Once turned on it cannot be undone. Check the details in the confirmation dialog before turning it on.",
      stateLabel: "State",
      state: {
        loading: "Loading",
        unknown: "Unknown",
        unrestricted: "Off",
        activating: "Turning on…",
        restricted: "On (cannot be removed)",
        unavailable: "Could not be checked",
      },
      request: "Turn on the external sending restriction…",
      requesting: "Showing the confirmation dialog…",
    },
    guidance: {
      graphNeedsRestriction:
        "Graph relations are available only in a profile with the external sending restriction turned on.",
    },
    chat: {
      aiClosed:
        "External sending is restricted, so AI replies are not available. Input in a scene's conversation is still saved.",
      sendClosed:
        "While external sending is restricted, input cannot be saved in a conversation that is not a scene's.",
      editClosed:
        "While external sending is restricted, messages in a conversation that is not a scene's cannot be edited and resent. They can still be deleted.",
    },
    import: {
      chatsRestricted:
        "Conversations cannot be imported while external sending is restricted, so {{count}} conversation(s) were not imported.",
    },
    result: {
      activated: "The external sending restriction is on.",
      cancelled: "Cancelled. The external sending restriction did not change.",
      expired: "The confirmation expired. Try again.",
      busy: "Another operation is in progress. Wait a moment and try again.",
      "already-restricted": "The external sending restriction is already on.",
      unavailable: "The external sending restriction cannot be turned on now.",
      "not-activated":
        "This version cannot turn on the external sending restriction yet.",
      refused: "The request was not accepted.",
    },
  },
} as const;

let installed = false;

/** Register the strings in both locales without replacing other resources. */
export function ensureProfileEgressTranslations(): void {
  if (installed) return;
  for (const [language, profileEgress] of Object.entries(
    PROFILE_EGRESS_TRANSLATIONS,
  )) {
    i18next.addResourceBundle(
      language,
      "translation",
      { profileEgress },
      true,
      true,
    );
  }
  installed = true;
}
