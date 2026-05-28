import type {
  MapSticky,
  MapEdge,
  MapFrame,
  MapNodePosition,
} from "@/db/schema";
import type { NodeRefType } from "./types";
import { prosemirrorToText } from "@/lib/prosemirror";

export interface ResolvedLabel {
  kind: NodeRefType;
  title: string;
}

export interface BuildMapContextInput {
  boardTitle: string;
  stickies: MapSticky[];
  edges: MapEdge[];
  frames: MapFrame[];
  positions: MapNodePosition[];
  /**
   * Edge endpoint (= position) を「種別 + 表示名」に変換する。
   * Sticky は呼び出し前に input.stickies に揃っているため
   * resolver は scene / codex / snippet / note / ai_branch のための
   * lookup map を caller 側で組み立てて渡す。null を返すと endpoint 解決失敗。
   */
  resolveLabel: (position: MapNodePosition) => ResolvedLabel | null;
}

const KIND_LABEL: Record<NodeRefType, string> = {
  sticky: "Sticky",
  scene: "Scene",
  note: "Note",
  codex: "Codex",
  snippet: "Snippet",
  ai_branch: "AIBranch",
};

function fallbackTitle(id: string): string {
  return `(untitled ${id.slice(0, 6)})`;
}

function stickyPlainText(sticky: MapSticky): string {
  const fromBody = prosemirrorToText(sticky.body).trim();
  if (fromBody) return fromBody;
  return (sticky.previewText ?? "").trim();
}

function resolveSticky(sticky: MapSticky): ResolvedLabel {
  const title = sticky.title?.trim() || fallbackTitle(sticky.id);
  return { kind: "sticky", title };
}

function positionCenter(
  position: MapNodePosition,
  sticky: MapSticky | undefined,
): { cx: number; cy: number } {
  // Position は (x, y) のみ。Sticky / その他ノードはサイズが固定化されておらず、
  // mapExport.ts と同じく default 幅 180 / 高 72 で center を近似する。
  // AABB 包含判定の用途のみで十分。
  const w = sticky ? 180 : 180;
  const h = sticky ? 72 : 72;
  return { cx: position.x + w / 2, cy: position.y + h / 2 };
}

function frameContains(frame: MapFrame, cx: number, cy: number): boolean {
  return (
    cx >= frame.x &&
    cx <= frame.x + frame.width &&
    cy >= frame.y &&
    cy <= frame.y + frame.height
  );
}

function renderStickyLine(sticky: MapSticky): string {
  const head = `- **${sticky.title?.trim() || fallbackTitle(sticky.id)}** (Sticky)`;
  const body = stickyPlainText(sticky);
  if (!body) return head;
  const indented = body
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
  return `${head}\n${indented}`;
}

function renderEndpoint(label: ResolvedLabel): string {
  return `[${KIND_LABEL[label.kind]}] "${label.title}"`;
}

function renderEdge(
  edge: MapEdge,
  from: ResolvedLabel,
  to: ResolvedLabel,
): string {
  const fwd = edge.forwardLabel?.trim() ?? "";
  const back = edge.backwardLabel?.trim() ?? "";
  const left = renderEndpoint(from);
  const right = renderEndpoint(to);

  if (edge.direction === "forward") {
    return fwd ? `- ${left} → ${right}: ${fwd}` : `- ${left} → ${right}`;
  }
  if (edge.direction === "bidirectional") {
    if (fwd && back) {
      return `- ${left} ↔ ${right}: (→ ${fwd}) / (← ${back})`;
    }
    if (fwd) return `- ${left} ↔ ${right}: → ${fwd}`;
    if (back) return `- ${left} ↔ ${right}: ← ${back}`;
    return `- ${left} ↔ ${right}`;
  }
  // direction === "none"
  if (fwd && back) {
    return `- ${left} ─ ${right}: (${fwd} / ${back})`;
  }
  const label = fwd || back;
  return label ? `- ${left} ─ ${right}: ${label}` : `- ${left} ─ ${right}`;
}

/**
 * Map board 全体を AI prompt 用 markdown にシリアライズする。
 *
 * Output 構造:
 *   <map board="...">
 *   ## Frame: ...
 *     - **Sticky title** (Sticky)
 *       body...
 *   ## Floating (frame 外)
 *     - ...
 *   ## Edges
 *     - [Sticky] "..." → [Codex] "...": label
 *   </map>
 *
 * 空のセクションは出力しない。Sticky 以外 (Scene / Codex / Snippet / Note /
 * AIBranch) は **Sticky 本文は持たないため Frame セクションには列挙しない** —
 * 関係性は Edges セクションで言及される。これにより Sticky body の長文ノイズ
 * と Codex 等の独立した情報を二重に AI に渡さない（Codex 本文は L4 別経路で
 * mention されたら注入される設計）。
 */
export function buildMapContextMarkdown(input: BuildMapContextInput): string {
  const stickyById = new Map<string, MapSticky>(
    input.stickies.map((s) => [s.id, s]),
  );
  const positionById = new Map<string, MapNodePosition>(
    input.positions.map((p) => [p.id, p]),
  );

  // Sticky position → Frame 配属（中心点 AABB 包含）。
  // 1 Sticky 1 Frame（複数 Frame に重なったら zIndex 降順優先 → 後勝ち回避）。
  const framesSorted = [...input.frames].sort((a, b) => b.zIndex - a.zIndex);
  const stickyToFrame = new Map<string, MapFrame>(); // stickyId → frame
  const floatingStickies: MapSticky[] = [];

  for (const pos of input.positions) {
    if (pos.nodeRefType !== "sticky" || !pos.stickyId) continue;
    const sticky = stickyById.get(pos.stickyId);
    if (!sticky) continue;
    const { cx, cy } = positionCenter(pos, sticky);
    const frame = framesSorted.find((f) => frameContains(f, cx, cy));
    if (frame) {
      stickyToFrame.set(sticky.id, frame);
    } else {
      floatingStickies.push(sticky);
    }
  }

  // Frame ごとに membership を構築
  const frameMembers = new Map<string, MapSticky[]>();
  for (const [stickyId, frame] of stickyToFrame) {
    const arr = frameMembers.get(frame.id) ?? [];
    const sticky = stickyById.get(stickyId);
    if (sticky) arr.push(sticky);
    frameMembers.set(frame.id, arr);
  }

  const sections: string[] = [];

  // Frame セクション (members を持つもののみ)
  for (const frame of input.frames) {
    const members = frameMembers.get(frame.id);
    if (!members || members.length === 0) continue;
    const title = frame.title?.trim() || "Frame";
    const lines = [`## Frame: ${title}`, ...members.map(renderStickyLine)];
    sections.push(lines.join("\n"));
  }

  // Floating セクション
  if (floatingStickies.length > 0) {
    const lines = [
      "## Floating (frame 外)",
      ...floatingStickies.map(renderStickyLine),
    ];
    sections.push(lines.join("\n"));
  }

  // Edges セクション
  const edgeLines: string[] = [];
  for (const edge of input.edges) {
    const fromPos = positionById.get(edge.fromPositionId);
    const toPos = positionById.get(edge.toPositionId);
    if (!fromPos || !toPos) continue;

    const fromLabel = resolveEndpoint(fromPos, stickyById, input.resolveLabel);
    const toLabel = resolveEndpoint(toPos, stickyById, input.resolveLabel);
    if (!fromLabel || !toLabel) continue;

    edgeLines.push(renderEdge(edge, fromLabel, toLabel));
  }
  if (edgeLines.length > 0) {
    sections.push(["## Edges", ...edgeLines].join("\n"));
  }

  if (sections.length === 0) {
    // 空 board: tag だけは出して context 上の存在を示す
    return `<map board="${escapeAttr(input.boardTitle)}">\n(empty board)\n</map>`;
  }

  return `<map board="${escapeAttr(input.boardTitle)}">\n\n${sections.join("\n\n")}\n\n</map>`;
}

function resolveEndpoint(
  position: MapNodePosition,
  stickyById: Map<string, MapSticky>,
  resolver: BuildMapContextInput["resolveLabel"],
): ResolvedLabel | null {
  if (position.nodeRefType === "sticky" && position.stickyId) {
    const sticky = stickyById.get(position.stickyId);
    return sticky ? resolveSticky(sticky) : null;
  }
  return resolver(position);
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, "&quot;");
}
