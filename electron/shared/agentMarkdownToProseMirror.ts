import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import {
  defaultMarkdownParser,
  MarkdownParser,
  type ParseSpec,
} from "prosemirror-markdown";

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
