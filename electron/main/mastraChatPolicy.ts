const AI_POLICY_PRESETS = new Set([
  "full",
  "assist-off",
  "review-only",
  "off",
  "custom",
]);
const REQUIRED_TOGGLES = ["chat", "bodyWrite", "analysis"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** NULL and an unset value retain the renderer's documented full default. */
export function aiPolicyAllowsChat(raw: unknown): boolean {
  if (raw === null || raw === undefined) return true;
  if (typeof raw !== "string" || raw.trim().length === 0) return false;
  try {
    const parsed: unknown = JSON.parse(raw);
    const toggles = isRecord(parsed) ? parsed.toggles : null;
    if (
      !isRecord(parsed) ||
      typeof parsed.preset !== "string" ||
      !AI_POLICY_PRESETS.has(parsed.preset) ||
      !isRecord(toggles) ||
      !REQUIRED_TOGGLES.every((key) => key in toggles)
    ) {
      return false;
    }
    return Boolean(toggles.chat);
  } catch {
    return false;
  }
}

/** Read Native's object-row result; an absent or malformed row is unreadable. */
export function projectAiChatPolicyAllows(rawResult: unknown): boolean {
  if (typeof rawResult !== "string") return false;
  try {
    const result: unknown = JSON.parse(rawResult);
    if (
      !isRecord(result) ||
      !Array.isArray(result.rows) ||
      result.rows.length !== 1
    ) {
      return false;
    }
    const row: unknown = result.rows[0];
    if (!isRecord(row) || !Object.hasOwn(row, "ai_policy")) return false;
    return aiPolicyAllowsChat(row.ai_policy);
  } catch {
    return false;
  }
}
