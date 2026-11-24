/** Legacy foreshadow secret writes are retired from in-app agent tools. */
export function isAgentForeshadowSecretInputSupported(
  toolName: string,
  input: unknown,
): boolean {
  if (toolName !== "create_foreshadow" && toolName !== "update_foreshadow") {
    return true;
  }
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return false;
  }
  const record = input as Record<string, unknown>;
  if (toolName === "create_foreshadow") {
    return !Object.hasOwn(record, "secret") || record.secret === false;
  }
  return !Object.hasOwn(record, "secret");
}
