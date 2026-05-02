export const JSON_ONLY =
  "Return only valid JSON. No prose, no markdown, no code fences.";

/**
 * Extract the first balanced JSON object from arbitrary text.
 *
 * Handles AI responses that include preamble (e.g. "Sure! {...}") by tracking
 * bracket depth and respecting string literals. Uses the first `{`…matching `}`
 * pair rather than lastIndexOf("}") to avoid mis-cutting nested objects.
 */
export function extractJsonObject(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const start = trimmed.indexOf("{");
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      if (inString) escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) return trimmed.slice(start, i + 1);
    }
  }
  return null;
}
