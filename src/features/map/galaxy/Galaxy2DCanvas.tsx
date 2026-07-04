import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ForceGraph2D from "react-force-graph-2d";
import type { ForceGraphMethods } from "react-force-graph-2d";
import { useCodexHighlightStore } from "@/features/editor/codexHighlightStore";
import { useReducedMotion } from "@/lib/animation";
import type { GalaxyGraph, GalaxyNode, GalaxyEdgeKind } from "../galaxyGraph";

interface Galaxy2DCanvasProps {
  graph: GalaxyGraph;
  /** シングルクリック（ダブルクリックの 1 打目でも呼ばれる） */
  onSelectNode: (node: GalaxyNode) => void;
  onOpenNode: (node: GalaxyNode) => void;
}

const BACKGROUND = "#05060f";
const DIM_NODE = "#232637";
const DIM_LINK = "#14161f";
const HIGHLIGHT_LINK = "#e8ecff";

const NODE_COLORS: Record<GalaxyNode["kind"], string> = {
  scene: "#cfe8ff",
  codex: "#8b7fe8",
  event: "#f5b04d",
  thread: "#e86fb4",
};

const LINK_COLORS: Record<GalaxyEdgeKind, string> = {
  mention: "#5f79c9",
  relation: "#c95f9f",
  sequence: "#8fa3c9",
  eventLink: "#c9a05f",
  participant: "#a05fc9",
  thread: "#5fc9a0",
};

const DOUBLE_CLICK_MS = 350;

function endpointId(end: unknown): string {
  if (typeof end === "object" && end !== null && "id" in end) {
    return String((end as { id: unknown }).id);
  }
  return String(end);
}

/**
 * ギャラクシービューの 2D 描画層（Canvas 2D、WebGL 不要）。
 * グロー表現は shadowBlur で代替する。3D 版（GalaxyCanvas）と
 * インタラクション仕様を揃えること。
 */
export function Galaxy2DCanvas({
  graph,
  onSelectNode,
  onOpenNode,
}: Galaxy2DCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const fgRef = useRef<ForceGraphMethods | undefined>(undefined);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const reducedMotion = useReducedMotion();
  const typeColorMap = useCodexHighlightStore((s) => s.typeColorMap);

  // autoPauseRedraw=false で毎フレーム accessor が再評価されるため、
  // hover は ref に置くだけで反映される（re-render 不要）
  const hoverRef = useRef<{ nodeId: string | null; neighbors: Set<string> }>({
    nodeId: null,
    neighbors: new Set(),
  });
  const lastClickRef = useRef<{ nodeId: string; at: number } | null>(null);
  const didFitRef = useRef(false);

  const data = useMemo(
    () => ({
      nodes: graph.nodes.map((n) => ({ ...n })),
      links: graph.links.map((l) => ({ ...l })),
    }),
    [graph],
  );

  const adjacency = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const n of graph.nodes) map.set(n.id, new Set());
    for (const l of graph.links) {
      map.get(l.source)?.add(l.target);
      map.get(l.target)?.add(l.source);
    }
    return map;
  }, [graph]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) setSize({ width: rect.width, height: rect.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const baseColor = useCallback(
    (node: GalaxyNode) =>
      node.kind === "codex"
        ? (typeColorMap[node.typeSlug ?? ""]?.fg ?? NODE_COLORS.codex)
        : node.kind === "thread"
          ? (node.color ?? NODE_COLORS.thread)
          : NODE_COLORS[node.kind],
    [typeColorMap],
  );

  const drawNode = useCallback(
    (
      node: GalaxyNode & { x?: number; y?: number },
      ctx: CanvasRenderingContext2D,
    ) => {
      const { nodeId, neighbors } = hoverRef.current;
      const dimmed =
        nodeId !== null && node.id !== nodeId && !neighbors.has(node.id);
      const color = dimmed ? DIM_NODE : baseColor(node);
      const r = 2.5 * Math.sqrt(node.val);
      const x = node.x ?? 0;
      const y = node.y ?? 0;
      ctx.save();
      if (!dimmed) {
        ctx.shadowColor = color;
        ctx.shadowBlur = r * 3;
      }
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, 2 * Math.PI);
      ctx.fill();
      ctx.restore();
    },
    [baseColor],
  );

  const paintPointerArea = useCallback(
    (
      node: GalaxyNode & { x?: number; y?: number },
      color: string,
      ctx: CanvasRenderingContext2D,
    ) => {
      const r = 2.5 * Math.sqrt(node.val);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(node.x ?? 0, node.y ?? 0, r, 0, 2 * Math.PI);
      ctx.fill();
    },
    [],
  );

  const linkColor = useCallback((link: object) => {
    const { nodeId } = hoverRef.current;
    const l = link as {
      kind: GalaxyEdgeKind;
      source: unknown;
      target: unknown;
    };
    if (!nodeId) return LINK_COLORS[l.kind];
    const touches =
      endpointId(l.source) === nodeId || endpointId(l.target) === nodeId;
    return touches ? HIGHLIGHT_LINK : DIM_LINK;
  }, []);

  const linkWidth = useCallback((link: object) => {
    const { nodeId } = hoverRef.current;
    if (!nodeId) return 1;
    const l = link as { source: unknown; target: unknown };
    const touches =
      endpointId(l.source) === nodeId || endpointId(l.target) === nodeId;
    return touches ? 2 : 1;
  }, []);

  const handleHover = useCallback(
    (node: GalaxyNode | null) => {
      hoverRef.current = node
        ? { nodeId: node.id, neighbors: adjacency.get(node.id) ?? new Set() }
        : { nodeId: null, neighbors: new Set() };
    },
    [adjacency],
  );

  const handleClick = useCallback(
    (node: GalaxyNode & { x?: number; y?: number }) => {
      const now = Date.now();
      const last = lastClickRef.current;
      lastClickRef.current = { nodeId: node.id, at: now };
      if (last && last.nodeId === node.id && now - last.at < DOUBLE_CLICK_MS) {
        lastClickRef.current = null;
        onOpenNode(node);
        return;
      }
      // シングルクリック: 対応パネルで選択し、ノードへセンタリング
      onSelectNode(node);
      fgRef.current?.centerAt(
        node.x ?? 0,
        node.y ?? 0,
        reducedMotion ? 0 : 800,
      );
    },
    [onSelectNode, onOpenNode, reducedMotion],
  );

  return (
    <div ref={containerRef} className="h-full w-full">
      {size.width > 0 && size.height > 0 && (
        <ForceGraph2D
          ref={fgRef}
          width={size.width}
          height={size.height}
          graphData={data}
          backgroundColor={BACKGROUND}
          warmupTicks={80}
          cooldownTime={reducedMotion ? 0 : 3000}
          // hover ハイライトは外部 ref を読む custom 描画のため、エンジン停止後の
          // 再描画自動停止（既定 true）を無効にしないと停止後に反映されなくなる
          autoPauseRedraw={false}
          onEngineStop={() => {
            // 初回収束時のみ全体が収まるようフィットする
            if (didFitRef.current) return;
            didFitRef.current = true;
            fgRef.current?.zoomToFit(reducedMotion ? 0 : 400, 40);
          }}
          nodeVal={(n) => (n as GalaxyNode).val}
          nodeLabel={(n) => (n as GalaxyNode).label}
          nodeCanvasObject={(n, ctx) => drawNode(n as GalaxyNode, ctx)}
          nodePointerAreaPaint={(n, color, ctx) =>
            paintPointerArea(n as GalaxyNode, color, ctx)
          }
          linkColor={linkColor}
          linkWidth={linkWidth}
          onNodeHover={(n) => handleHover(n as GalaxyNode | null)}
          onNodeClick={(n) => handleClick(n as GalaxyNode)}
          onBackgroundClick={() => handleHover(null)}
        />
      )}
    </div>
  );
}
