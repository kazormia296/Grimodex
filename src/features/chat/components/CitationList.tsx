import { useTranslation } from "react-i18next";
import { Globe2 } from "lucide-react";
import type { Citation } from "../agent/agentTypes";
import { openExternalUrl } from "@/lib/safeUrl";

interface CitationListProps {
  citations: Citation[];
}

/** URL のホスト名を取り出す。パース不能なら URL をそのまま返す。 */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * Web 検索 (RAG) の引用ソース一覧。回答の下に番号付きで表示する。
 *
 * セキュリティ: `<a href>` でレンダーすると WebView がそのまま遷移し、また
 * 取得コンテンツ由来 URL の自動プリフェッチ経路になりうる。明示クリックで
 * `openUrl` (OS デフォルトブラウザ) に渡し、自動ロードはしない (設計書 §3-4)。
 */
export function CitationList({ citations }: CitationListProps) {
  const { t } = useTranslation();
  if (citations.length === 0) return null;

  // http(s)/mailto に限定して OS ブラウザで開く（上流 sanitizeCitations に加えた
  // 二重防御。citation URL は検索プロバイダ＝第三者由来のため単一点依存を避ける）。
  const open = (url: string) => openExternalUrl(url);

  return (
    <div className="mt-2 border-t border-border/40 pt-1.5">
      <div className="mb-1 flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
        <Globe2 className="h-3 w-3" />
        <span>{t("chat.webSearch.sources", { count: citations.length })}</span>
      </div>
      <ol className="space-y-0.5">
        {citations.map((c, i) => (
          <li key={`${c.url}-${i}`} className="flex gap-1.5 text-xs">
            <span className="shrink-0 tabular-nums text-muted-foreground/60">
              {i + 1}.
            </span>
            <button
              type="button"
              onClick={() => open(c.url)}
              title={c.citedText ? `${c.url}\n\n${c.citedText}` : c.url}
              className="truncate text-left text-primary/90 hover:text-primary hover:underline"
            >
              {c.title || hostOf(c.url)}
              <span className="ml-1 text-muted-foreground/50">
                {hostOf(c.url)}
              </span>
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}
