/**
 * 外部 URL を OS デフォルトブラウザで開く際のスキーム検証 (defense-in-depth)。
 *
 * チャット本文のリンク/画像 URL や Web 検索 RAG の citation URL は、プロンプト
 * インジェクションされた第三者 Web コンテンツ由来になりうる。`openUrl` に
 * `javascript:` / `file:` / `data:` / `vbscript:` 等を渡すと、WebView 内 XSS には
 * ならないものの OS ハンドラ経由で危険スキームの起動・ローカルファイル参照に
 * 繋がりうる。レンダリング側 (react-markdown の urlTransform / citation の上流
 * sanitize) の防御に**加えて**、`openUrl` 呼び出し境界でも http(s)/mailto に限定し、
 * 防御を単一点依存にしない。
 */
const SAFE_SCHEMES = new Set(["http:", "https:", "mailto:"]);

/** http(s)/mailto のみ true。相対 URL・パース不能・危険スキームは false。 */
export function isSafeExternalUrl(url: string): boolean {
  try {
    return SAFE_SCHEMES.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

/**
 * 安全な URL のみ OS デフォルトブラウザで開く。危険/不正スキームは黙って無視。
 * 明示クリック時のみ呼ぶこと（自動ロードはしない）。
 */
export function openExternalUrl(url: string): void {
  if (!isSafeExternalUrl(url)) return;
  void import("@tauri-apps/plugin-opener")
    .then(({ openUrl }) => openUrl(url))
    .catch(() => {
      // opener 不在 (テスト等) では無視。
    });
}
