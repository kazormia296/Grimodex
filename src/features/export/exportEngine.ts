import { startsWithJapaneseDialogue } from "@/lib/paragraphIndentPolicy";
import {
  generateExport as generateExportCore,
  type GenerateExportInput,
} from "./exportEngineCore";

export * from "./exportEngineCore";

interface PMNode {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: PMNode[];
}

// U+FEFF is ECMAScript whitespace, so exportEngineCore recognizes the marked
// paragraph as already indented. The private-use payload makes accidental
// collision with manuscript text vanishingly unlikely. The complete sentinel
// is removed before generateExport returns and can never reach user output.
const DIALOGUE_INDENT_SENTINEL =
  "\uFEFF\uE000grimodex-dialogue-indent-exempt\uE001";

function firstRenderedText(node: PMNode): string {
  if (node.type === "text") return node.text ?? "";
  if (node.type === "ruby") return String(node.attrs?.base ?? "");
  if (node.type === "hardBreak") return "\n";
  if (node.type === "sceneBeat") return "";

  if (node.content) {
    for (const child of node.content) {
      const text = firstRenderedText(child);
      if (text.length > 0) return text;
    }
    return "";
  }

  // An unknown inline atom is visible content. Do not inspect later siblings
  // and mistake a following quote for the paragraph opener.
  return "\uFFFC";
}

function markDialogueParagraphs(rawDocument: string): string {
  try {
    const parsed = JSON.parse(rawDocument) as PMNode;
    if (parsed.type !== "doc" || !Array.isArray(parsed.content)) {
      return rawDocument;
    }

    let changed = false;
    const content = parsed.content.map((node) => {
      if (
        node.type !== "paragraph" ||
        !startsWithJapaneseDialogue(firstRenderedText(node))
      ) {
        return node;
      }

      changed = true;
      return {
        ...node,
        content: [
          { type: "text", text: DIALOGUE_INDENT_SENTINEL },
          ...(node.content ?? []),
        ],
      };
    });

    return changed ? JSON.stringify({ ...parsed, content }) : rawDocument;
  } catch {
    // Keep the core engine's existing invalid-JSON fallback behavior.
    return rawDocument;
  }
}

function usesAutomaticParagraphIndent(input: GenerateExportInput): boolean {
  return (
    input.settings.paragraphIndent === "fullwidth-space" ||
    (input.settings.format === "html" &&
      input.settings.paragraphIndent === "css")
  );
}

/**
 * Public export facade. Dialogue paragraphs are marked as already indented
 * before the core renderer runs, then the internal marker is stripped from the
 * completed output. Author-entered leading whitespace remains untouched.
 */
export function generateExport(input: GenerateExportInput): string {
  if (!usesAutomaticParagraphIndent(input)) {
    return generateExportCore(input);
  }

  const contentMap = Object.fromEntries(
    Object.entries(input.contentMap).map(([sceneId, document]) => [
      sceneId,
      markDialogueParagraphs(document),
    ]),
  );
  const output = generateExportCore({ ...input, contentMap });
  return output.split(DIALOGUE_INDENT_SENTINEL).join("");
}
