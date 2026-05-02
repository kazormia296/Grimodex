const MAX_BEATS = 8;
const MAX_CHARS_PER_BEAT = 60;

type UnplacedBeatLike = { content: { text?: string }[] };

/**
 * Unplaced beats の配列から先頭 MAX_BEATS 件 × MAX_CHARS_PER_BEAT 文字の
 * プレビューを JSON 配列文字列として返す。
 * tree_nodes.unplaced_beat_preview カラムに保存し、Grid カードで bullet 表示する。
 *
 * フォーマット: '["line1","line2","line3"]'
 * バックエンドは値を opaque TEXT として保存するだけで中身を解釈しない。
 */
export function extractUnplacedBeatPreview(beats: UnplacedBeatLike[]): string {
  if (!beats?.length) return "[]";

  const items: string[] = [];
  for (const beat of beats) {
    if (items.length >= MAX_BEATS) break;
    const raw = (beat.content ?? [])
      .map((n) => n.text ?? "")
      .join("")
      .trim();
    if (!raw) continue;
    // Normalize whitespace (newlines, tabs → single space)
    const normalized = raw.replace(/[\n\r\t]+/g, " ").trim();
    items.push(normalized.slice(0, MAX_CHARS_PER_BEAT));
  }
  return JSON.stringify(items);
}
