import type { Node as PMNode } from "@tiptap/pm/model";
import type { BeatType } from "@/features/editor/SceneBeatNode";

export interface PlacedBeatInfo {
  beatId: string;
  /**
   * Position of the sceneBeat node.
   *
   * - `listPlacedBeats(doc)` (live PM doc 経由): PM の正確な doc position。
   *   PM トランザクションに渡しても安全。
   * - `listPlacedBeatsFromJson(json)` (JSON 経由): schema を持たないので
   *   `measureJsonNodeSize` による粗い近似値。**PM 操作には使わないこと**
   *   （atom/leaf のサイズ規則が schema 依存で本来の `node.nodeSize` と
   *   ずれる可能性があり、トランザクションを発行すると doc 破損する恐れ）。
   *   表示・順序付け用途に限る。
   */
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

/**
 * PM の `node.nodeSize` 規則を JSON 上で粗く近似する。
 *
 * 本来 `nodeSize` は schema 依存（leaf/atom/inline=1, block=2+content.size,
 * text=text.length）だが、ここでは schema を持たないので block 風 = 2 + 子サイズ、
 * leaf 風 = 1、text = 文字数 で近似する。
 *
 * **注意**: この値は `listPlacedBeatsFromJson` の `beatPos` 計算にしか使わず、
 * 結果は表示・順序付け用途に限る（PM トランザクションには渡さない）。
 */
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
