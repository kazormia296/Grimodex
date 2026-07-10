/** Japanese project language tags supported by the v1 yomi/IME protocol. */
export function isJapaneseProjectLanguage(
  language: string | null | undefined,
): boolean {
  if (!language) return false;
  const normalized = language.trim().toLowerCase();
  return (
    normalized === "ja" ||
    normalized.startsWith("ja-") ||
    normalized.startsWith("ja_")
  );
}
