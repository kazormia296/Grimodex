/**
 * Marks a save failure whose user-facing notification was already emitted by
 * the persistence owner. AutoSave still treats it as a failure, but skips its
 * generic duplicate toast.
 */
export class AlreadyNotifiedSaveError extends Error {
  /**
   * `cause` は store が握りつぶした元の error。quarantine の印
   * （WORKSPACE_QUARANTINED）を `useAutoSave` に届けるために渡す。
   */
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AlreadyNotifiedSaveError";
  }
}

export const INLINE_AI_SAVE_BLOCKED_MESSAGE =
  "Resolve the inline-AI preview before saving this document";

/**
 * 外部置換（revision 復元・agent 書込み・import など）の文書 lease の最中に、
 * 同じ文書の save が入場を拒まれたことを表す。lease は外部の writer が本文を
 * 置き換える間の入場拒否で、置換後は競合の案内が未保存の本文を守る。
 * 背景の autosave は toast を出さずに再試行する（EAR-13）。
 * `useAutoSave` から判別できるよう、coordinator ではなくここに置く
 * （coordinator は re-export する）。
 */
export class DocumentMutationLeaseActiveError extends Error {
  constructor() {
    super("This document is temporarily read-only while content is replaced");
    this.name = "DocumentMutationLeaseActiveError";
  }
}

/**
 * 保存の T0 で「今は保存を始めない」と呼び手が返す印（EAR-7）。伏線 mark の
 * 更新が日本語の変換中で適用できないとき、背景の autosave だけがこれを受け、
 * toast も失敗の記録も無しに数百 ms 後へ張り直す。flush（閉じる・切替・手動保存）
 * では投げない。doc の捕捉・hold・native の呼び出しより前に投げること。
 */
export class SaveDeferredError extends Error {
  constructor() {
    super("The save was deferred until the current IME composition ends");
    this.name = "SaveDeferredError";
  }
}
