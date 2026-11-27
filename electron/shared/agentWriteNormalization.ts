import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import {
  defaultMarkdownParser,
  MarkdownParser,
  type ParseSpec,
} from "prosemirror-markdown";

const MAX_CODEX_ALIASES = 100;
const MAX_CODEX_ALIAS_BYTES = 64_000;
const NODE_NAMES: Readonly<Record<string, string>> = {
  list_item: "listItem",
  bullet_list: "bulletList",
  ordered_list: "orderedList",
  code_block: "codeBlock",
  horizontal_rule: "horizontalRule",
  hard_break: "hardBreak",
};
const MARK_NAMES: Readonly<Record<string, string>> = {
  em: "italic",
  strong: "bold",
};

let parser: MarkdownParser | undefined;

/** Portable model Markdown projection shared by renderer and Main. */
export function agentMarkdownToProseMirrorJson(markdown: string): string {
  if (new TextEncoder().encode(markdown).byteLength > 1_000_000) {
    throw new Error("rich text input exceeds 1000000 bytes");
  }
  try {
    if (!parser) {
      const schema = getSchema([StarterKit.configure()]);
      const tokens = Object.fromEntries(
        Object.entries(defaultMarkdownParser.tokens).flatMap(([name, spec]) => {
          let normalized: ParseSpec | null = spec;
          if (spec.node) {
            const node = NODE_NAMES[spec.node] ?? spec.node;
            normalized = schema.nodes[node] ? { ...spec, node } : null;
          } else if (spec.block) {
            const block = NODE_NAMES[spec.block] ?? spec.block;
            normalized = schema.nodes[block] ? { ...spec, block } : null;
          } else if (spec.mark) {
            const mark = MARK_NAMES[spec.mark] ?? spec.mark;
            normalized = schema.marks[mark] ? { ...spec, mark } : null;
          }
          return normalized ? [[name, normalized]] : [];
        }),
      );
      parser = new MarkdownParser(
        schema,
        defaultMarkdownParser.tokenizer,
        tokens,
      );
    }
    const document = parser.parse(markdown);
    document.check();
    return JSON.stringify(document.toJSON());
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Markdown body could not be converted safely: ${reason}`, {
      cause: error,
    });
  }
}

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
