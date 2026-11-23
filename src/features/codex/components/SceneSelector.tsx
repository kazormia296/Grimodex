import { useTranslation } from "react-i18next";
import { useTreeStore, type TreeNodeData } from "@/features/tree/treeStore";

interface SceneSelectorProps {
  value: string | null;
  onChange: (nodeId: string | null) => void;
  /**
   * Narrows the scenes that can be chosen (after the "scene" node type check).
   * Without it every scene is listed, as before.
   */
  filter?: (node: TreeNodeData) => boolean;
}

export function SceneSelector({ value, onChange, filter }: SceneSelectorProps) {
  const { t } = useTranslation();
  const nodes = useTreeStore((s) => s.nodes);
  const scenes = nodes.filter(
    (n) => n.nodeType === "scene" && (filter ? filter(n) : true),
  );

  return (
    <select
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
      className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
    >
      <option value="">{t("codex.sceneSelector.none")}</option>
      {scenes.map((scene) => (
        <option key={scene.id} value={scene.id}>
          {scene.title}
        </option>
      ))}
    </select>
  );
}
