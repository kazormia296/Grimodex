/**
 * exportValidation.ts — エクスポート前の事前検査。
 *
 * 現状はサイト別ルビ文字数上限のみ。警告のみでブロックはしない。
 * プリセットに `rubyLimit` が定義されている場合だけ走査する。
 */
import type { TreeNodeData } from "@/features/tree/treeStore";
import type { ExportPresetId } from "./types";
import { getSiteRubyLimit } from "./rubyProfiles";

export interface RubyLengthWarning {
  sceneId: string;
  sceneTitle: string;
  base: string;
  annotation: string;
  /** どちらの上限を超えたか */
  exceeded: "base" | "ruby";
  /** 超過した上限値 */
  limit: number;
  /** 実際の文字数（コードポイント単位） */
  actual: number;
}

export interface ValidateExportInput {
  nodes: TreeNodeData[];
  contentMap: Record<string, string>;
  checkedIds: Set<string>;
  presetId: ExportPresetId;
}

interface PMNodeLike {
  type?: string;
  attrs?: Record<string, unknown>;
  content?: PMNodeLike[];
}

function walkRuby(
  node: PMNodeLike,
  visit: (base: string, annotation: string) => void,
): void {
  if (!node || typeof node !== "object") return;
  if (node.type === "ruby") {
    const base = typeof node.attrs?.base === "string" ? node.attrs.base : "";
    const annotation =
      typeof node.attrs?.annotation === "string" ? node.attrs.annotation : "";
    if (base) visit(base, annotation);
    // ruby は葉ノード扱いなので子は再帰しない
    return;
  }
  if (Array.isArray(node.content)) {
    for (const child of node.content) walkRuby(child, visit);
  }
}

function codePointLen(s: string): number {
  return [...s].length;
}

export function validateExportRubyLengths(
  input: ValidateExportInput,
): RubyLengthWarning[] {
  const { nodes, contentMap, checkedIds, presetId } = input;
  if (presetId === "custom") return [];
  const rubyLimit = getSiteRubyLimit(presetId);
  if (!rubyLimit) return [];
  const { baseMax, rubyMax } = rubyLimit;

  const warnings: RubyLengthWarning[] = [];
  const sceneById = new Map(nodes.map((n) => [n.id, n]));

  for (const sceneId of checkedIds) {
    const node = sceneById.get(sceneId);
    if (!node || node.nodeType !== "scene") continue;
    const raw = contentMap[sceneId];
    if (!raw) continue;
    let doc: PMNodeLike;
    try {
      doc = JSON.parse(raw);
    } catch {
      continue;
    }
    walkRuby(doc, (base, annotation) => {
      const baseLen = codePointLen(base);
      const rubyLen = codePointLen(annotation);
      if (baseLen > baseMax) {
        warnings.push({
          sceneId,
          sceneTitle: node.title,
          base,
          annotation,
          exceeded: "base",
          limit: baseMax,
          actual: baseLen,
        });
      }
      if (rubyLen > rubyMax) {
        warnings.push({
          sceneId,
          sceneTitle: node.title,
          base,
          annotation,
          exceeded: "ruby",
          limit: rubyMax,
          actual: rubyLen,
        });
      }
    });
  }
  return warnings;
}
