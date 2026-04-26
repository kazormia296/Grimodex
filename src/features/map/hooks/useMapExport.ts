import { useEffect } from "react";
import type { Edge, Node } from "@xyflow/react";
import { buildMapSVG, svgToPngBlob, buildMapJSON } from "../mapExport";
import { toast } from "sonner";

type ExportType = "svg" | "png" | "json";

export function useMapExport(
  pendingExport: ExportType | null,
  setPendingExport: (v: ExportType | null) => void,
  getNodes: () => Node[],
  getEdges: () => Edge[],
) {
  useEffect(() => {
    if (!pendingExport) return;
    const type = pendingExport;
    setPendingExport(null);

    async function doExport() {
      const rfNodes = getNodes();
      const rfEdges = getEdges();

      if (type === "json") {
        const { save } = await import("@tauri-apps/plugin-dialog");
        const { writeTextFile } = await import("@tauri-apps/plugin-fs");
        const path = await save({
          defaultPath: "map.json",
          filters: [{ name: "JSON", extensions: ["json"] }],
        });
        if (!path) return;
        await writeTextFile(path, buildMapJSON(rfNodes, rfEdges));
        return;
      }

      const svgContent = buildMapSVG(rfNodes, rfEdges);

      if (type === "svg") {
        const { save } = await import("@tauri-apps/plugin-dialog");
        const { writeTextFile } = await import("@tauri-apps/plugin-fs");
        const path = await save({
          defaultPath: "map.svg",
          filters: [{ name: "SVG", extensions: ["svg"] }],
        });
        if (!path) return;
        await writeTextFile(path, svgContent);
        return;
      }

      if (type === "png") {
        const { save } = await import("@tauri-apps/plugin-dialog");
        const { writeFile } = await import("@tauri-apps/plugin-fs");
        const path = await save({
          defaultPath: "map.png",
          filters: [{ name: "PNG", extensions: ["png"] }],
        });
        if (!path) return;
        const blob = await svgToPngBlob(svgContent);
        const buf = await blob.arrayBuffer();
        await writeFile(path, new Uint8Array(buf));
      }
    }

    doExport().catch((err) => {
      console.error(err);
      toast.error("エクスポートに失敗しました", { description: String(err) });
    });
  }, [pendingExport, setPendingExport, getNodes, getEdges]);
}
