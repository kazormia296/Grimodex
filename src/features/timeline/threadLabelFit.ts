// 全角（CJK・かな・全角記号・ハングル等）の概略レンジ。該当文字は 1em 幅、
// それ以外（ラテン等の半角）は約 0.55em として扱う近似。
const FULLWIDTH =
  /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︐-︙︰-﹯＀-｠￠-￦]|[\u{20000}-\u{3FFFF}]/u;

function charWidth(ch: string, fontSize: number): number {
  return FULLWIDTH.test(ch) ? fontSize : fontSize * 0.55;
}

/**
 * スレッドヘッダー（カプセル型ラベル）に収まるよう名前を末尾省略する。
 * SVG `<text>` は CSS の `truncate`/ellipsis が効かないため、全角=1em /
 * 半角≈0.55em の近似で文字幅を積み上げ、`maxWidth`(px) を超えたら "…" を
 * 付けて打ち切る。コードポイント単位で走査し、サロゲートペアを割らない。
 */
export function fitLabelToWidth(
  name: string,
  maxWidth: number,
  fontSize: number,
): string {
  if (maxWidth <= 0) return "";
  const chars = [...name];
  let total = 0;
  for (const ch of chars) total += charWidth(ch, fontSize);
  if (total <= maxWidth) return name;

  // 省略記号ぶん（全角級）を差し引いた予算で本体を詰める。
  const budget = maxWidth - fontSize;
  let acc = 0;
  let out = "";
  for (const ch of chars) {
    const w = charWidth(ch, fontSize);
    if (acc + w > budget) break;
    acc += w;
    out += ch;
  }
  return out + "…";
}
