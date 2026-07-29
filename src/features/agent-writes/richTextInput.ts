import { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { getSchema } from "@tiptap/core";
import {
  defaultMarkdownParser,
  MarkdownParser,
  type ParseSpec,
} from "prosemirror-markdown";
import StarterKit from "@tiptap/starter-kit";
import { AuthorshipMark } from "@/features/attribution/AuthorshipMark";

/** Same order of magnitude as the MCP sanitizer; measured as UTF-8 bytes. */
export const MAX_AGENT_RICH_TEXT_BYTES = 1_000_000;

let editorSchema: ReturnType<typeof getSchema> | null = null;
let agentMarkdownParser: MarkdownParser | null = null;

/**
 * Agent-authored bodies intentionally use the portable subset shared by the
 * Codex/Chronicle mini editor and the full EditorPane. Importing EditorPane's
 * interactive extension registry here would create an agent -> editor ->
 * agent module cycle; restricting writes to this subset still guarantees that
 * every produced node/mark is accepted by both real editors.
 */
function getCanonicalEditorSchema(): ReturnType<typeof getSchema> {
  if (editorSchema === null) {
    editorSchema = getSchema([StarterKit.configure(), AuthorshipMark]);
  }
  return editorSchema;
}

const MARKDOWN_NODE_NAMES: Readonly<Record<string, string>> = {
  list_item: "listItem",
  bullet_list: "bulletList",
  ordered_list: "orderedList",
  code_block: "codeBlock",
  horizontal_rule: "horizontalRule",
  hard_break: "hardBreak",
};

const MARKDOWN_MARK_NAMES: Readonly<Record<string, string>> = {
  em: "italic",
  strong: "bold",
};

function remapMarkdownSpec(
  spec: ParseSpec,
  schema: ReturnType<typeof getSchema>,
): ParseSpec | null {
  if (spec.node) {
    const node = MARKDOWN_NODE_NAMES[spec.node] ?? spec.node;
    return schema.nodes[node] ? { ...spec, node } : null;
  }
  if (spec.block) {
    const block = MARKDOWN_NODE_NAMES[spec.block] ?? spec.block;
    return schema.nodes[block] ? { ...spec, block } : null;
  }
  if (spec.mark) {
    const mark = MARKDOWN_MARK_NAMES[spec.mark] ?? spec.mark;
    return schema.marks[mark] ? { ...spec, mark } : null;
  }
  return spec;
}

function getAgentMarkdownParser(): MarkdownParser {
  if (agentMarkdownParser === null) {
    const schema = getCanonicalEditorSchema();
    const tokens = Object.fromEntries(
      Object.entries(defaultMarkdownParser.tokens).flatMap(([name, spec]) => {
        const remapped = remapMarkdownSpec(spec, schema);
        return remapped ? [[name, remapped]] : [];
      }),
    );
    agentMarkdownParser = new MarkdownParser(
      schema,
      defaultMarkdownParser.tokenizer,
      tokens,
    );
  }
  return agentMarkdownParser;
}

function assertSize(input: string): void {
  const bytes = new TextEncoder().encode(input).byteLength;
  if (bytes > MAX_AGENT_RICH_TEXT_BYTES) {
    throw new Error(
      `rich text input exceeds ${MAX_AGENT_RICH_TEXT_BYTES} bytes`,
    );
  }
}

/**
 * Parse and validate a serialized document with the portable Agent schema.
 * The normalized return value is safe to persist and is a strict subset of
 * every editor that can open an Agent-authored body.
 */
export function validateAgentProseMirrorJson(input: string): string {
  assertSize(input);
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new Error("rich text content is not valid JSON");
  }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("rich text content must be a ProseMirror document object");
  }
  let doc: ProseMirrorNode;
  try {
    doc = ProseMirrorNode.fromJSON(getCanonicalEditorSchema(), parsed);
    doc.check();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `rich text content does not match the editor schema: ${reason}`,
      { cause: error },
    );
  }
  if (doc.type.name !== "doc") {
    throw new Error("rich text content root must be a doc node");
  }
  return JSON.stringify(doc.toJSON());
}

/** Convert model-authored Markdown into canonical, schema-validated PM JSON. */
export function agentMarkdownToProseMirrorJson(markdown: string): string {
  assertSize(markdown);
  try {
    const converted = getAgentMarkdownParser().parse(markdown).toJSON();
    return validateAgentProseMirrorJson(JSON.stringify(converted));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Markdown body could not be converted safely: ${reason}`, {
      cause: error,
    });
  }
}
