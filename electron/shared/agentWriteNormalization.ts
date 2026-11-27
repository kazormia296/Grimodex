import { agentMarkdownToProseMirrorJson } from "./agentMarkdownToProseMirror.js";

export { agentMarkdownToProseMirrorJson } from "./agentMarkdownToProseMirror.js";

const MAX_CODEX_ALIASES = 100;
const MAX_CODEX_ALIAS_BYTES = 64_000;

export function agentCodexAliases(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("aliases must be an array of strings");
  }
  if (value.length > MAX_CODEX_ALIASES) {
    throw new Error(`aliases must contain at most ${MAX_CODEX_ALIASES} items`);
  }
  const serialized = JSON.stringify(
    value.map((item) => item.trim()).filter(Boolean),
  );
  if (new TextEncoder().encode(serialized).byteLength > MAX_CODEX_ALIAS_BYTES) {
    throw new Error(`aliases exceed ${MAX_CODEX_ALIAS_BYTES} bytes`);
  }
  return serialized;
}

/** Convert public model tool fields to the native writer's established names. */
export function normalizeMastraAgentWriteInput(
  name: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const payload = { ...input };
  switch (name) {
    case "update_foreshadow":
      payload.foreshadowId = payload.id;
      delete payload.id;
      break;
    case "create_codex_entry":
      payload.typeSlug = payload.type;
      delete payload.type;
      if (payload.content !== undefined && payload.content !== null) {
        if (typeof payload.content !== "string")
          throw new Error("content must be a Markdown string");
        payload.content = agentMarkdownToProseMirrorJson(payload.content);
      }
      payload.aliases = agentCodexAliases(payload.aliases);
      break;
    case "update_codex_entry":
      payload.entryId = payload.id;
      delete payload.id;
      if (payload.content !== undefined && payload.content !== null) {
        if (typeof payload.content !== "string")
          throw new Error("content must be a Markdown string");
        payload.content = agentMarkdownToProseMirrorJson(payload.content);
      }
      payload.aliases = agentCodexAliases(payload.aliases);
      break;
    case "create_event":
    case "update_event":
      if (payload.detail !== undefined && payload.detail !== null) {
        if (typeof payload.detail !== "string")
          throw new Error("detail must be a Markdown string");
        payload.detail = agentMarkdownToProseMirrorJson(payload.detail);
      }
      break;
    case "create_snippet":
      if (payload.content !== undefined && payload.content !== null) {
        if (typeof payload.content !== "string")
          throw new Error("content must be a Markdown string");
        payload.content = agentMarkdownToProseMirrorJson(payload.content);
      }
      break;
    case "set_event_participants":
      payload.codexEntryIds =
        payload.participantCodexIds ?? payload.codexEntryIds;
      delete payload.participantCodexIds;
      break;
    default:
      break;
  }
  return payload;
}
