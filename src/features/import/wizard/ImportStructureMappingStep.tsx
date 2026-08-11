import type { ImportSourceNode } from "../core/importSourceNode";

interface Props {
  readonly nodes: readonly ImportSourceNode[];
}

export function ImportStructureMappingStep({ nodes }: Props) {
  const roots = nodes.filter((n) => n.parentKey === null);

  return (
    <section
      className="flex flex-col gap-2"
      data-testid="import-wizard-structure-step"
    >
      <p className="text-xs text-muted-foreground">
        構造マッピング（プレビュー）— {nodes.length} ノード
      </p>
      <ul className="max-h-40 overflow-y-auto rounded border border-border p-2 text-xs">
        {roots.map((node) => (
          <li key={node.key}>
            {node.title} ({node.kind})
            <StructureChildren nodes={nodes} parentKey={node.key} depth={1} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function StructureChildren({
  nodes,
  parentKey,
  depth,
}: {
  readonly nodes: readonly ImportSourceNode[];
  readonly parentKey: string;
  readonly depth: number;
}) {
  const children = nodes.filter((n) => n.parentKey === parentKey);
  if (children.length === 0) return null;
  return (
    <ul className="ml-3">
      {children.map((child) => (
        <li key={child.key}>
          {child.title} ({child.kind})
          <StructureChildren
            nodes={nodes}
            parentKey={child.key}
            depth={depth + 1}
          />
        </li>
      ))}
    </ul>
  );
}
