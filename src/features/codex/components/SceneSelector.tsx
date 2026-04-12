import { useTreeStore } from "@/features/tree/treeStore";

interface SceneSelectorProps {
  value: string | null;
  onChange: (nodeId: string | null) => void;
}

export function SceneSelector({ value, onChange }: SceneSelectorProps) {
  const nodes = useTreeStore((s) => s.nodes);
  const scenes = nodes.filter((n) => n.nodeType === "scene");

  return (
    <select
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
      className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
    >
      <option value="">--- なし ---</option>
      {scenes.map((scene) => (
        <option key={scene.id} value={scene.id}>
          {scene.title}
        </option>
      ))}
    </select>
  );
}
