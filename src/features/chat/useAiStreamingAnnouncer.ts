import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { announce } from "@/lib/a11y/announcer";
import { useChatStore } from "./chatStore";

/**
 * AI 応答ストリームの開始/終了をスクリーンリーダーへ読み上げる。
 *
 * チャットのメッセージ表示は aria-live 領域ではないため、SR 利用者には生成の
 * 開始も完了も伝わらない。`isStreaming` の boolean 遷移を監視して announce する。
 *
 * **失敗時は読み上げない**: error パスは `error` を立てたうえで Sonner の
 * エラートーストを出す。トーストは Sonner 自身の aria-live で読まれるため、ここで
 * "完了" を足すと二重読み上げ + 失敗の誤ラベルになる (本タスクの「Sonner と二重
 * 読み上げ厳禁」)。よって完了 announce は `error == null` の遷移に限定する。
 *
 * 単一マウントが保証される場所 (App の EditorScreen) から1度だけ呼ぶこと。
 */
export function useAiStreamingAnnouncer(): void {
  const { t } = useTranslation();
  const isStreaming = useChatStore((s) => s.isStreaming);
  const prevRef = useRef(isStreaming);

  useEffect(() => {
    const prev = prevRef.current;
    if (isStreaming && !prev) {
      announce(t("a11y.aiGenerating"));
    } else if (!isStreaming && prev) {
      const hadError = useChatStore.getState().error != null;
      if (!hadError) announce(t("a11y.aiGenerated"));
    }
    prevRef.current = isStreaming;
  }, [isStreaming, t]);
}
