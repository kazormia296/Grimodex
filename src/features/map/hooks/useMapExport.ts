import { useEffect } from "react";
import type { Edge, Node } from "@xyflow/react";
import { buildMapSVG, svgToPngBlob, buildMapJSON } from "../mapExport";
import { saveTextFile, saveBinaryFile } from "@/lib/exportFile";
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

      // 保存ダイアログは Rust 側で開かれ、renderer はパスを渡さない
      // (security audit PIO-2)。非 Tauri は browser ダウンロード。
      if (type === "json") {
        await saveTextFile(
          "map.json",
          { name: "JSON", extensions: ["json"] },
          buildMapJSON(rfNodes, rfEdges),
          "application/json",
        );
        return;
      }

      const svgContent = buildMapSVG(rfNodes, rfEdges);

      if (type === "svg") {
        await saveTextFile(
          "map.svg",
          { name: "SVG", extensions: ["svg"] },
          svgContent,
          "image/svg+xml",
        );
        return;
      }

      if (type === "png") {
        const blob = await svgToPngBlob(svgContent);
        const bytes = new Uint8Array(await blob.arrayBuffer());
        await saveBinaryFile(
          "map.png",
          { name: "PNG", extensions: ["png"] },
          bytes,
          "image/png",
        );
      }
    }

    doExport().catch((err) => {
      console.error(err);
      toast.error("エクスポートに失敗しました", { description: String(err) });
    });
  }, [pendingExport, setPendingExport, getNodes, getEdges]);
}
