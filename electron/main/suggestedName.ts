/**
 * 保存 dialog の初期の名前の正規化（K3/2 SF-1 の 7 の (a)。DA-1）。
 *
 * renderer が渡す `suggestedName` は dialog の `defaultPath` になり、絶対 path を
 * 受け付けてしまう。Main は単一のファイル名にしてから渡す。初期値は dialog の
 * 初期の名前だけで、利用者は dialog で自由に変えられる。
 * 通常の名前（拡張子つきのファイル名）は変えない。
 */

/** `.` と `..` だけの名前と、空になる名前に使う既定名。 */
export const DEFAULT_SUGGESTED_NAME = "export";

/** 名前の長さの上限（code point）。通常のファイル名の上限（255 byte）より十分短い。 */
export const MAX_SUGGESTED_NAME_LENGTH = 120;

/** 拡張子として残す長さの上限（`.` を含む）。 */
const MAX_EXTENSION_LENGTH = 17;

export function sanitizeSuggestedName(
  raw: string,
  platform: NodeJS.Platform = process.platform,
): string {
  // path の区切り、NUL、制御文字を置き換える。Windows は drive の区切りも。
  // eslint-disable-next-line no-control-regex
  let name = String(raw).replace(/[\\/\u0000-\u001f\u007f]/g, "_");
  if (platform === "win32") name = name.replace(/:/g, "_");
  if (name.trim() === "" || /^\.+$/.test(name)) return DEFAULT_SUGGESTED_NAME;

  const chars = Array.from(name);
  if (chars.length <= MAX_SUGGESTED_NAME_LENGTH) return name;

  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? Array.from(name.slice(dot)) : [];
  const keepExtension =
    extension.length > 1 && extension.length <= MAX_EXTENSION_LENGTH;
  if (!keepExtension) {
    return chars.slice(0, MAX_SUGGESTED_NAME_LENGTH).join("");
  }
  const stem = Array.from(name.slice(0, dot));
  return (
    stem.slice(0, MAX_SUGGESTED_NAME_LENGTH - extension.length).join("") +
    extension.join("")
  );
}
