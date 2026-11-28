/**
 * TipTap HTMLからAuthorshipMarkのspanタグ（data-authorship属性）を除去する。
 * ルビ・傍点等のHTMLタグは保持する。
 */
export function sanitizeSceneContent(html: string): string {
  // data-authorship属性を持つspanタグのみ除去（内容テキストは保持）
  return html.replace(
    /<span\b[^>]*\bdata-authorship\b[^>]*>([\s\S]*?)<\/span>/g,
    "$1",
  );
}
