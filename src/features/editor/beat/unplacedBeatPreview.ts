const MAX_BEATS = 3;
const MAX_CHARS_PER_BEAT = 40;

type UnplacedBeatLike = { content: { text?: string }[] };

/**
 * Unplaced beats の配列から先頭3件×40文字のプレビュー文字列を生成する。
 * Grid のステータスバー表示に使用する。
 */
export function extractUnplacedBeatPreview(beats: UnplacedBeatLike[]): string {
  if (!beats?.length) return "";

  const lines: string[] = [];
  for (const beat of beats) {
    if (lines.length >= MAX_BEATS) break;
    const text = beat.content
      .map((n) => n.text ?? "")
      .join("")
      .trim();
    if (!text) continue;
    lines.push(text.slice(0, MAX_CHARS_PER_BEAT));
  }
  return lines.join("\n");
}
