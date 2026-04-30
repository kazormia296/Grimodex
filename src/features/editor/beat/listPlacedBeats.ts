import type { Node as PMNode } from "@tiptap/pm/model";
import type { BeatType } from "@/features/editor/SceneBeatNode";

export interface PlacedBeatInfo {
  beatId: string;
  /** Doc position of the sceneBeat node start (0-indexed). */
  beatPos: number;
  /** 1-origin sequential index in doc order. */
  index: number;
  instructions: string;
  beatType: BeatType;
  povCharacterId: string | null;
}

type JsonNode = {
  type?: string;
  attrs?: Record<string, unknown>;
  content?: JsonNode[];
  text?: string;
};

function extractTextFromJsonContent(nodes: JsonNode[] | undefined): string {
  if (!nodes) return "";
  return nodes
    .map((n) =>
      n.type === "text"
        ? (n.text ?? "")
        : extractTextFromJsonContent(n.content),
    )
    .join("");
}

function isBeatType(value: unknown): value is BeatType {
  const valid = ["free", "summary", "guided", "dialogue", "setting", "micro"];
  return typeof value === "string" && valid.includes(value);
}

function measureJsonNodeSize(node: JsonNode): number {
  if (node.type === "text") return node.text?.length ?? 1;
  if (!node.content || node.content.length === 0) return 1;
  return 2 + node.content.reduce((acc, n) => acc + measureJsonNodeSize(n), 0);
}

/**
 * Walk PM-JSON (plain object, no schema required) and list all top-level
 * sceneBeat nodes in doc order. Safe to call when the editor is unavailable
 * (e.g. in chat context). sceneBeat is always a top-level block node.
 */
export function listPlacedBeatsFromJson(docJson: unknown): PlacedBeatInfo[] {
  const root = docJson as JsonNode | null | undefined;
  if (!root || !Array.isArray(root.content)) return [];

  const results: PlacedBeatInfo[] = [];
  let pos = 1; // PM convention: inside doc opening token

  for (const node of root.content) {
    if (node.type === "sceneBeat") {
      const attrs = node.attrs ?? {};
      const beatId = typeof attrs.id === "string" ? attrs.id : null;
      if (beatId) {
        results.push({
          beatId,
          beatPos: pos,
          index: results.length + 1,
          instructions: extractTextFromJsonContent(node.content),
          beatType: isBeatType(attrs.beatType) ? attrs.beatType : "free",
          povCharacterId: typeof attrs.pov === "string" ? attrs.pov : null,
        });
      }
    }
    pos += measureJsonNodeSize(node);
  }

  return results;
}

/**
 * Walk a live ProseMirror doc and list all sceneBeat nodes in order.
 * Preferred when the Editor instance is available (accurate positions).
 */
export function listPlacedBeats(doc: PMNode): PlacedBeatInfo[] {
  const results: PlacedBeatInfo[] = [];

  doc.descendants((node, pos) => {
    if (node.type.name === "sceneBeat") {
      const attrs = node.attrs as {
        id?: string;
        beatType?: BeatType;
        pov?: string | null;
      };
      if (attrs.id) {
        results.push({
          beatId: attrs.id,
          beatPos: pos,
          index: results.length + 1,
          instructions: node.textContent,
          beatType: isBeatType(attrs.beatType) ? attrs.beatType : "free",
          povCharacterId: attrs.pov ?? null,
        });
      }
      return false; // Don't descend into sceneBeat's inline children
    }
    return true;
  });

  return results;
}
