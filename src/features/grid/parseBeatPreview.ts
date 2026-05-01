/**
 * tree_nodes.unplaced_beat_preview 値を文字列配列に変換する safe parser。
 *
 * 現行フォーマット: JSON 配列文字列 '["line1","line2","line3"]'
 * 旧フォーマット (legacy): 改行区切り文字列 "line1\nline2\nline3"
 *   → 改行区切り値が残っている間は fallback で読み込む（次回保存で自然に新形式へ移行）
 *
 * 壊れた値では例外を投げず null を返す（カードの beat 領域を非表示にする）。
 */
export function parseBeatPreview(
  raw: string | null | undefined,
): string[] | null {
  if (!raw || raw === "[]") return null;

  // Try JSON array first (current format)
  try {
    const parsed = JSON.parse(raw);
    if (
      Array.isArray(parsed) &&
      parsed.every((item) => typeof item === "string")
    ) {
      return parsed.length > 0 ? parsed : null;
    }
  } catch {
    // fall through to legacy format
  }

  // Legacy: newline-separated string (plain text, not JSON)
  if (!raw.startsWith("[") && !raw.startsWith("{")) {
    const lines = raw
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    return lines.length > 0 ? lines : null;
  }

  return null;
}
