import { useState, useEffect, useRef, useCallback } from "react";
import { useTreeStore } from "./treeStore";

interface SynopsisAreaProps {
  nodeId: string;
}

export function SynopsisArea({ nodeId }: SynopsisAreaProps) {
  const nodes = useTreeStore((s) => s.nodes);
  const updateSynopsis = useTreeStore((s) => s.updateSynopsis);
  const node = nodes.find((n) => n.id === nodeId);
  const [text, setText] = useState(node?.synopsis ?? "");
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sync external changes
  useEffect(() => {
    setText(node?.synopsis ?? "");
  }, [node?.synopsis]);

  const handleChange = useCallback(
    (value: string) => {
      setText(value);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        updateSynopsis(nodeId, value).catch(() => {});
      }, 1000);
    },
    [nodeId, updateSynopsis],
  );

  if (!node || node.nodeType !== "scene") return null;

  return (
    <div className="border-t border-border p-2">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">
          Synopsis
        </span>
      </div>
      <textarea
        value={text}
        onChange={(e) => handleChange(e.target.value)}
        placeholder="What happens in this scene?"
        className="w-full resize-none rounded border border-border bg-background px-2 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-ring"
        rows={3}
      />
    </div>
  );
}
