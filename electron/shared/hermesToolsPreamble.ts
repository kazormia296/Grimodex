/**
 * Nous Hermes 標準の function-calling system プロンプト断片を組む。
 * Rust `build_hermes_tools_preamble` と同趣旨（`<tools>` にツール schema を列挙）。
 */
export function buildHermesToolsPreamble(
  tools: ReadonlyArray<{
    name: string;
    description: string;
    inputSchema: unknown;
  }>,
): string {
  const lines = tools.map((t) =>
    JSON.stringify({
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    }),
  );
  return (
    "You are a function calling AI model. You are provided with function signatures within " +
    "<tools></tools> XML tags. You may call one or more functions to assist with the user query. " +
    "Don't make assumptions about what values to plug into functions. " +
    "Here are the available tools:\n<tools>\n" +
    lines.join("\n") +
    "\n</tools>\n" +
    "For each function call, return a json object with the function name and arguments within " +
    "<tool_call></tool_call> XML tags, like:\n" +
    '<tool_call>\n{"name": <function-name>, "arguments": <args-dict>}\n</tool_call>\n' +
    "The tool result is returned within <tool_response></tool_response> tags. " +
    "Only call tools listed above."
  );
}
