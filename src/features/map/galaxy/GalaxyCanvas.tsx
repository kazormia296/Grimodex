import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ForceGraph3D from "react-force-graph-3d";
import type { ForceGraphMethods } from "react-force-graph-3d";
import { Vector2 } from "three";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { useCodexHighlightStore } from "@/features/editor/codexHighlightStore";
import { useReducedMotion } from "@/lib/animation";
import type { GalaxyGraph, GalaxyNode, GalaxyEdgeKind } from "../galaxyGraph";

interface GalaxyCanvasProps {
  graph: GalaxyGraph;
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

// react-force-graph はシミュレーション開始後に link の source/target を
// ノードオブジェクト参照へ差し替えるため、両形を吸収して id に落とす。
function endpointId(end: unknown): string {
  if (typeof end === "object" && end !== null && "id" in end) {
    return String((end as { id: unknown }).id);
  }
  return String(end);
}

/**
 * ギャラクシービューの 3D 描画層。WebGL 依存のため自動テスト対象外
 * （グラフ導出ロジックは galaxyGraph.ts 側で gate 済み）。
 */
export function GalaxyCanvas({ graph, onOpenNode }: GalaxyCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const fgRef = useRef<ForceGraphMethods | undefined>(undefined);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const reducedMotion = useReducedMotion();
  const typeColorMap = useCodexHighlightStore((s) => s.typeColorMap);

  // hover 状態は accessor から参照するだけなので re-render 不要。ref に持ち、
  // 変更時は refresh() で再描画だけ促す。
  const hoverRef = useRef<{ nodeId: string | null; neighbors: Set<string> }>({
    nodeId: null,
    neighbors: new Set(),
  });
  const lastClickRef = useRef<{ nodeId: string; at: number } | null>(null);

  // graphData はライブラリ側が座標等を書き込んで変異させる。呼び出し元の
  // graph を守るため、graph が変わるたびに浅いコピーを渡す。
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

  // bloom は一度だけ追加する。strength/threshold は「淡くにじむ」程度に抑える
  // （強すぎると高次数ノードが白飛びして色の区別が消える）。
  const bloomAddedRef = useRef(false);
  useEffect(() => {
    if (bloomAddedRef.current) return;
    const composer = fgRef.current?.postProcessingComposer?.();
    if (!composer) return;
    composer.addPass(
      new UnrealBloomPass(
        new Vector2(size.width, size.height),
        0.42,
        0.35,
        0.35,
      ),
    );
    bloomAddedRef.current = true;
  }, [size.width, size.height]);

  // 自動回転: reduced-motion では無効。最初のユーザー操作で停止。
  useEffect(() => {
    const controls = fgRef.current?.controls?.() as
      | {
          autoRotate?: boolean;
          autoRotateSpeed?: number;
          addEventListener?: (type: string, cb: () => void) => void;
          removeEventListener?: (type: string, cb: () => void) => void;
        }
      | undefined;
    if (!controls) return;
    controls.autoRotate = !reducedMotion;
    controls.autoRotateSpeed = 0.35;
    const stop = () => {
      controls.autoRotate = false;
    };
    controls.addEventListener?.("start", stop);
    return () => controls.removeEventListener?.("start", stop);
  }, [reducedMotion, size.width]);

  const nodeColor = useCallback(
    (node: GalaxyNode) => {
      const { nodeId, neighbors } = hoverRef.current;
      const base =
        node.kind === "codex"
          ? (typeColorMap[node.typeSlug ?? ""]?.fg ?? NODE_COLORS.codex)
          : node.kind === "thread"
            ? (node.color ?? NODE_COLORS.thread)
            : NODE_COLORS[node.kind];
      if (!nodeId) return base;
      return node.id === nodeId || neighbors.has(node.id) ? base : DIM_NODE;
    },
    [typeColorMap],
  );

  const linkColor = useCallback((link: { kind: GalaxyEdgeKind } & object) => {
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
    if (!nodeId) return 0;
    const l = link as { source: unknown; target: unknown };
    const touches =
      endpointId(l.source) === nodeId || endpointId(l.target) === nodeId;
    return touches ? 1.2 : 0;
  }, []);

  const handleHover = useCallback(
    (node: GalaxyNode | null) => {
      hoverRef.current = node
        ? { nodeId: node.id, neighbors: adjacency.get(node.id) ?? new Set() }
        : { nodeId: null, neighbors: new Set() };
      fgRef.current?.refresh();
    },
    [adjacency],
  );

  const handleClick = useCallback(
    (node: GalaxyNode & { x?: number; y?: number; z?: number }) => {
      const now = Date.now();
      const last = lastClickRef.current;
      lastClickRef.current = { nodeId: node.id, at: now };
      if (last && last.nodeId === node.id && now - last.at < DOUBLE_CLICK_MS) {
        lastClickRef.current = null;
        onOpenNode(node);
        return;
      }
      // シングルクリック: ノードへカメラを寄せる
      const x = node.x ?? 0;
      const y = node.y ?? 0;
      const z = node.z ?? 0;
      const dist = Math.hypot(x, y, z) || 1;
      const ratio = 1 + 60 / dist;
      fgRef.current?.cameraPosition(
        { x: x * ratio, y: y * ratio, z: z * ratio },
        { x, y, z },
        reducedMotion ? 0 : 800,
      );
    },
    [onOpenNode, reducedMotion],
  );

  return (
    <div ref={containerRef} className="h-full w-full">
      {size.width > 0 && size.height > 0 && (
        <ForceGraph3D
          ref={fgRef}
          width={size.width}
          height={size.height}
          graphData={data}
          backgroundColor={BACKGROUND}
          showNavInfo={false}
          controlType="orbit"
          warmupTicks={80}
          cooldownTime={reducedMotion ? 0 : 3000}
          nodeVal={(n) => (n as GalaxyNode).val}
          nodeLabel={(n) => (n as GalaxyNode).label}
          nodeColor={(n) => nodeColor(n as GalaxyNode)}
          nodeOpacity={0.9}
          nodeResolution={12}
          linkColor={(l) => linkColor(l as { kind: GalaxyEdgeKind })}
          linkWidth={linkWidth}
          linkOpacity={0.4}
          onNodeHover={(n) => handleHover(n as GalaxyNode | null)}
          onNodeClick={(n) => handleClick(n as GalaxyNode)}
          onBackgroundClick={() => handleHover(null)}
        />
      )}
    </div>
  );
}
