import { useTranslation } from "react-i18next";
import { Sparkles, X } from "lucide-react";
import { useChatStore } from "../chatStore";

interface ChatRecallPromoteBannerProps {
  /** 「Codex に昇格」を押したとき: 既存の抽出ダイアログを recall 本文で開く。
   * recall 対象は過去セッションのこともあるので messages からは引かず text を渡す。 */
  onPromote: (messageId: string, text: string) => void;
}

/**
 * エピソード recall が同じ過去発言を何度も引いたときに出す「Codex に昇格しますか？」
 * バナー (柔→硬の橋渡し)。composer の直上に控えめに表示する。昇格は既存の抽出 UI へ
 * 委譲し、ここでは自動書き込みをしない (recall-only)。
 */
export function ChatRecallPromoteBanner({
  onPromote,
}: ChatRecallPromoteBannerProps) {
  const { t } = useTranslation();
  const suggestion = useChatStore((s) => s.chatRecallPromoteSuggestion);
  const dismiss = useChatStore((s) => s.dismissChatRecallPromote);

  if (!suggestion) return null;

  const preview = suggestion.text.replace(/\s+/g, " ").trim().slice(0, 60);

  return (
    <div className="flex items-start gap-2 border-t border-border bg-accent/30 px-3 py-2 text-xs">
      <Sparkles
        className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <p className="text-foreground">{t("chat.recallPromote.title")}</p>
        <p className="truncate text-muted-foreground" title={suggestion.text}>
          「{preview}
          {suggestion.text.length > 60 ? "…" : ""}」
        </p>
      </div>
      <button
        type="button"
        onClick={() => onPromote(suggestion.messageId, suggestion.text)}
        className="shrink-0 rounded border border-border px-2 py-0.5 text-foreground hover:bg-accent"
      >
        {t("chat.recallPromote.action")}
      </button>
      <button
        type="button"
        onClick={() => dismiss(suggestion.messageId)}
        aria-label={t("chat.recallPromote.dismiss")}
        className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
      >
        <X className="size-3.5" aria-hidden />
      </button>
    </div>
  );
}
