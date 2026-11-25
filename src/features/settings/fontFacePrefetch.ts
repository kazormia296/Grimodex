/**
 * 日本語の同梱可変フォント (Noto Serif JP / M PLUS 1) は約 120 の unicode-range slice に
 * 分かれている。slice は「その字を初めて描くとき」に取得され、取得が終わるたびに
 * Chromium はそのフォントを使う全テキストを再 style・再 layout する。長い本文
 * （約 5 万字）を開いたあとに未取得の字を打つと、slice ごとに約 100 ms の long task になり、
 * 自動保存の性能予算 (long task 90 ms) を超える。
 *
 * そこで CSS を読み込んだら、本文が小さい（または空の）うちに全 slice を先に取得しておく。
 * 取得は 1 回ずつ完了するが、再 layout が安い間に済ませるのが目的で、太さ (wght 軸) は
 * 同じ face が持つので追加の取得は要らない。
 */
const PREFETCH_FAMILIES: ReadonlySet<string> = new Set([
  "Noto Serif JP",
  "M PLUS 1",
]);

function unquote(family: string): string {
  return family.trim().replace(/^["']|["']$/g, "");
}

function documentFonts(): FontFaceSet | null {
  return typeof document === "undefined" ? null : (document.fonts ?? null);
}

export function shouldPrefetchFontFaces(family: string): boolean {
  return PREFETCH_FAMILIES.has(family);
}

/**
 * `family` の未取得の @font-face をすべて読み込む。失敗した slice は無視する
 * （未取得のまま通常どおり必要になった時点で取得される）。
 */
export function prefetchFontFaces(
  family: string,
  fonts: Pick<FontFaceSet, "forEach"> | null = documentFonts(),
): Promise<number> {
  if (!fonts || !shouldPrefetchFontFaces(family)) return Promise.resolve(0);
  const pending: Promise<unknown>[] = [];
  fonts.forEach((face) => {
    if (unquote(face.family) !== family || face.status !== "unloaded") return;
    pending.push(face.load().catch(() => undefined));
  });
  return Promise.all(pending).then(() => pending.length);
}
