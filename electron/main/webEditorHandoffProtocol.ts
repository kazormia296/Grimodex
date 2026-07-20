export interface WebEditorHandoffProtocolRequest {
  kind: "web-editor-handoff";
}

const WEB_EDITOR_HANDOFF_URLS: ReadonlySet<string> = new Set([
  "grimodex://handoff",
  "grimodex://handoff/",
]);

/**
 * Recognizes the payload-free Web Editor launch signal from either a raw URL
 * or Electron's process/second-instance argv. Matching is deliberately raw
 * and exact so URL normalization cannot admit credentials, query parameters,
 * fragments, alternate paths, or encoded payloads.
 */
export function parseWebEditorHandoffProtocolRequest(
  argvOrUrl: string | readonly string[],
): WebEditorHandoffProtocolRequest | null {
  const candidates = typeof argvOrUrl === "string" ? [argvOrUrl] : argvOrUrl;
  return candidates.some((candidate) => WEB_EDITOR_HANDOFF_URLS.has(candidate))
    ? { kind: "web-editor-handoff" }
    : null;
}
