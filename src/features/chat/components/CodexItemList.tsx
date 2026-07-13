import { useMemo } from "react";

interface CodexItem {
  id: string;
  type?: string;
  status?: string;
  title?: string;
  text?: string;
  command?: string[];
  output?: string;
  affectedPaths?: string[];
  diff?: string;
}

function parseItems(raw: unknown): CodexItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((value): CodexItem[] => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return [];
    }
    const item = value as Record<string, unknown>;
    if (typeof item.id !== "string" || item.id.length === 0) return [];
    return [
      {
        id: item.id,
        ...(typeof item.type === "string" ? { type: item.type } : {}),
        ...(typeof item.status === "string" ? { status: item.status } : {}),
        ...(typeof item.title === "string" ? { title: item.title } : {}),
        ...(typeof item.text === "string" ? { text: item.text } : {}),
        ...(Array.isArray(item.command)
          ? {
              command: item.command.filter(
                (part): part is string => typeof part === "string",
              ),
            }
          : {}),
        ...(typeof item.output === "string" ? { output: item.output } : {}),
        ...(Array.isArray(item.affectedPaths)
          ? {
              affectedPaths: item.affectedPaths.filter(
                (path): path is string => typeof path === "string",
              ),
            }
          : {}),
        ...(typeof item.diff === "string" ? { diff: item.diff } : {}),
      },
    ];
  });
}

export function CodexItemList({ raw }: { raw: unknown }) {
  const items = useMemo(() => parseItems(raw), [raw]);
  if (items.length === 0) return null;
  return (
    <div className="mb-2 space-y-1" data-testid="codex-item-list">
      {items.map((item) => (
        <details
          key={item.id}
          className="rounded border border-border/70 bg-background/40 px-2 py-1 text-xs"
          open={item.status === "failed"}
        >
          <summary className="cursor-pointer text-muted-foreground">
            <span className="font-medium text-foreground">
              {item.title || item.type || "Codex item"}
            </span>
            {item.status ? ` · ${item.status}` : ""}
          </summary>
          {item.text && <p className="mt-1 whitespace-pre-wrap">{item.text}</p>}
          {item.command && item.command.length > 0 && (
            <pre className="mt-1 max-h-40 overflow-auto rounded bg-muted p-1 font-mono">
              {item.command.join(" ")}
            </pre>
          )}
          {item.affectedPaths && item.affectedPaths.length > 0 && (
            <p className="mt-1 break-all text-muted-foreground">
              {item.affectedPaths.join("\n")}
            </p>
          )}
          {item.output && (
            <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap rounded bg-muted p-1 font-mono">
              {item.output}
            </pre>
          )}
          {item.diff && (
            <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap rounded bg-muted p-1 font-mono">
              {item.diff}
            </pre>
          )}
        </details>
      ))}
    </div>
  );
}
