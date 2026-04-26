import type { Node, Edge } from "@xyflow/react";

function escapeXML(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function nodeWidth(n: Node): number {
  return (n.measured?.width ?? n.width ?? 180) as number;
}

function nodeHeight(n: Node): number {
  return (n.measured?.height ?? n.height ?? 72) as number;
}

function nodeFill(type: string | undefined): string {
  switch (type) {
    case "note":
      return "#FEFCE8";
    case "codex":
      return "#EEF2FF";
    default:
      return "#FFFFFF";
  }
}

function nodeLabel(n: Node): string {
  const d = n.data as Record<string, unknown>;
  return String(d.title ?? d.name ?? "").slice(0, 40);
}

/** Build an SVG string from React Flow node/edge data. */
export function buildMapSVG(rfNodes: Node[], rfEdges: Edge[]): string {
  const visible = rfNodes.filter((n) => n.type !== "frame");
  if (visible.length === 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200" width="400" height="200">
  <text x="200" y="100" text-anchor="middle" font-family="sans-serif" fill="#6B7280">No nodes</text>
</svg>`;
  }

  const PAD = 40;
  const xs = visible.map((n) => n.position.x);
  const ys = visible.map((n) => n.position.y);
  const x2s = visible.map((n) => n.position.x + nodeWidth(n));
  const y2s = visible.map((n) => n.position.y + nodeHeight(n));

  const minX = Math.min(...xs) - PAD;
  const minY = Math.min(...ys) - PAD;
  const maxX = Math.max(...x2s) + PAD;
  const maxY = Math.max(...y2s) + PAD;
  const W = maxX - minX;
  const H = maxY - minY;

  // Node id → position map (center point)
  const centerOf = new Map<string, { x: number; y: number }>();
  for (const n of visible) {
    centerOf.set(n.id, {
      x: n.position.x + nodeWidth(n) / 2 - minX,
      y: n.position.y + nodeHeight(n) / 2 - minY,
    });
  }

  // Edges: bezier from right-handle of source to left-handle of target
  const edgesSVG = rfEdges
    .map((e) => {
      const src = centerOf.get(e.source);
      const tgt = centerOf.get(e.target);
      if (!src || !tgt) return "";
      const srcNode = visible.find((n) => n.id === e.source);
      const tgtNode = visible.find((n) => n.id === e.target);
      if (!srcNode || !tgtNode) return "";
      const x1 = srcNode.position.x + nodeWidth(srcNode) - minX;
      const y1 = srcNode.position.y + nodeHeight(srcNode) / 2 - minY;
      const x2 = tgtNode.position.x - minX;
      const y2 = tgtNode.position.y + nodeHeight(tgtNode) / 2 - minY;
      const cx = (x1 + x2) / 2;
      const isDerived = e.id?.startsWith("derived:");
      const stroke = isDerived ? "#9CA3AF" : "#6366F1";
      const dash = isDerived ? 'stroke-dasharray="4 3"' : "";
      return `  <path d="M${x1},${y1} C${cx},${y1} ${cx},${y2} ${x2},${y2}" fill="none" stroke="${stroke}" stroke-width="1.5" ${dash}/>`;
    })
    .filter(Boolean)
    .join("\n");

  // Nodes
  const nodesSVG = visible
    .map((n) => {
      const x = n.position.x - minX;
      const y = n.position.y - minY;
      const w = nodeWidth(n);
      const h = nodeHeight(n);
      const fill = nodeFill(n.type);
      const label = nodeLabel(n);
      const opacity = (n.style as Record<string, unknown> | undefined)?.opacity;
      const opacityAttr =
        opacity !== undefined && opacity !== 1 ? ` opacity="${opacity}"` : "";
      return `  <g${opacityAttr}>
    <rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" stroke="#9CA3AF" stroke-width="1.5" rx="6"/>
    <text x="${x + 10}" y="${y + h / 2 + 4}" font-size="12" font-family="sans-serif" fill="#374151" font-weight="500">${escapeXML(label)}</text>
  </g>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="white"/>
${edgesSVG}
${nodesSVG}
</svg>`;
}

/** Convert SVG string → PNG Blob via canvas. */
export async function svgToPngBlob(svgContent: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const svgBlob = new Blob([svgContent], { type: "image/svg+xml" });
    const url = URL.createObjectURL(svgBlob);
    const img = new window.Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth || 800;
      canvas.height = img.naturalHeight || 600;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("canvas.toBlob failed"));
      }, "image/png");
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("SVG image load failed"));
    };
    img.src = url;
  });
}

/** Serialize current map state as JSON. */
export function buildMapJSON(rfNodes: Node[], rfEdges: Edge[]): string {
  const nodes = rfNodes
    .filter((n) => n.type !== "frame")
    .map((n) => ({
      id: n.id,
      type: n.type,
      x: n.position.x,
      y: n.position.y,
      width: nodeWidth(n),
      height: nodeHeight(n),
      data: n.data,
    }));
  const edges = rfEdges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    type: e.type,
  }));
  return JSON.stringify({ nodes, edges }, null, 2);
}
