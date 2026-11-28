import { classifyAiPolicy } from "../shared/aiPolicy/classifyAiPolicy.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** NULL は会話可。壊れた値（空文字を含む）は、chat が true と読めても拒む（DR-A4-5）。 */
export function aiPolicyAllowsChat(raw: unknown): boolean {
  const policy = classifyAiPolicy(raw);
  return (
    policy.state === "missing" ||
    (policy.state === "valid" && policy.toggles.chat)
  );
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
