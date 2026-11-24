/** Legacy event-tool history may replay secret=false, but event secrecy is retired. */
export function isAgentEventSecretInputSupported(
  toolName: string,
  input: unknown,
): boolean {
  if (toolName !== "create_event" && toolName !== "update_event") return true;
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return false;
  }
  const record = input as Record<string, unknown>;
  return !Object.hasOwn(record, "secret") || record.secret === false;
}
