import { useEffect } from "react";
import { listen } from "@/lib/tauri";
import { handleFileEvent } from "./mountManager";
import type { FileEvent } from "./types";

const CHANNELS: Array<{ channel: string; kind: FileEvent["kind"] }> = [
  { channel: "external-mount://file-changed", kind: "changed" },
  { channel: "external-mount://file-added", kind: "added" },
  { channel: "external-mount://file-removed", kind: "removed" },
  { channel: "external-mount://file-renamed", kind: "renamed" },
];

export function useExternalMountListener(): void {
  useEffect(() => {
    const unsubs: Array<() => void> = [];
    let cancelled = false;

    void (async () => {
      for (const { channel, kind } of CHANNELS) {
        const unlisten = await listen<{
          rootId: string;
          relPath: string;
          oldRelPath?: string | null;
        }>(channel, (payload) => {
          void handleFileEvent({
            rootId: payload.rootId,
            relPath: payload.relPath,
            oldRelPath: payload.oldRelPath,
            kind,
          });
        });
        if (cancelled) {
          unlisten();
        } else {
          unsubs.push(unlisten);
        }
      }
    })();

    return () => {
      cancelled = true;
      for (const u of unsubs) u();
    };
  }, []);
}
