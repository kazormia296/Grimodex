import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ImageOff } from "lucide-react";
import type { Components } from "react-markdown";

/** クリック時のみ OS デフォルトブラウザで開く。自動ロードはしない。 */
export function openExternal(url: string) {
  void import("@tauri-apps/plugin-opener")
    .then(({ openUrl }) => openUrl(url))
    .catch(() => {
      // opener 不在 (テスト等) では無視。
    });
}

/**
 * Markdown リンクのゲート化コンポーネント。`<a href>` の自動遷移/プリフェッチを
 * 避け、明示クリックで `openExternal` に渡す（設計書 §3-4 ゼロクリック exfil 対策）。
 */
export function MarkdownLink({
  href,
  children,
}: {
  href?: string;
  children?: ReactNode;
}) {
  if (!href) return <>{children}</>;
  return (
    <button
      type="button"
      onClick={() => openExternal(href)}
      title={href}
      className="cursor-pointer text-primary underline underline-offset-2 hover:text-primary/80"
    >
      {children}
    </button>
  );
}

/**
 * Markdown 画像を**自動ロードしない**プレースホルダ。画像 URL はゼロクリック
 * exfil チャネルになりうるため、レンダー時にネットワーク取得せず、明示クリックで
 * 外部に開く（設計書 §0-3 / §3-4）。
 */
export function MarkdownImage({ src, alt }: { src?: string; alt?: string }) {
  const { t } = useTranslation();
  const label = alt?.trim() || t("chat.markdown.image");
  return (
    <button
      type="button"
      onClick={() => src && openExternal(src)}
      title={src}
      className="my-1 inline-flex items-center gap-1 rounded border border-border bg-muted/40 px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted"
    >
      <ImageOff className="h-3 w-3" />
      <span>{label}</span>
    </button>
  );
}

/**
 * 経路非依存で常に適用する安全 markdown コンポーネント (a/img)。Codex
 * ハイライトの有効/無効に関わらず必ず噛ませる（自動ロード/自動遷移の遮断）。
 */
export const SAFE_COMPONENTS = {
  a: MarkdownLink,
  img: MarkdownImage,
} as Components;
