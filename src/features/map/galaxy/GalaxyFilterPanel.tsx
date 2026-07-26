import { useTranslation } from "react-i18next";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import type {
  GalaxyFilters,
  GalaxyFiltersPatch,
  GalaxyNodeFlags,
  GalaxyEdgeFlags,
} from "../types";

interface GalaxyFilterPanelProps {
  filters: GalaxyFilters;
  onChange: (patch: GalaxyFiltersPatch) => void;
}

const NODE_KEYS: Array<keyof GalaxyNodeFlags> = [
  "scenes",
  "codex",
  "events",
  "threads",
];
const EDGE_KEYS: Array<keyof GalaxyEdgeFlags> = [
  "mention",
  "relation",
  "sequence",
  "eventLink",
  "participant",
  "thread",
];

function FilterRow({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer select-none items-center gap-1.5 text-[11.5px]",
        checked ? "text-foreground" : "text-muted-foreground",
      )}
    >
      <Checkbox
        checked={checked}
        onCheckedChange={(v) => onChange(v === true)}
        className="h-3 w-3"
      />
      {label}
    </label>
  );
}

/** ギャラクシービュー右上のフローティングフィルタ（Obsidian 風）。 */
export function GalaxyFilterPanel({
  filters,
  onChange,
}: GalaxyFilterPanelProps) {
  const { t } = useTranslation();
  return (
    <div className="absolute right-3 top-3 z-10 flex w-[168px] flex-col gap-2 rounded-md border border-border bg-background/80 p-3 backdrop-blur">
      <div>
        <p className="mb-1.5 font-mono text-[9.5px] uppercase tracking-wider text-muted-foreground">
          {t("map.galaxy.nodeSection")}
        </p>
        <div className="flex flex-col gap-1">
          {NODE_KEYS.map((key) => (
            <FilterRow
              key={key}
              checked={filters.nodes[key]}
              onChange={(v) => onChange({ nodes: { [key]: v } })}
              label={t(`map.galaxy.nodes.${key}`)}
            />
          ))}
        </div>
      </div>
      <div>
        <p className="mb-1.5 font-mono text-[9.5px] uppercase tracking-wider text-muted-foreground">
          {t("map.galaxy.edgeSection")}
        </p>
        <div className="flex flex-col gap-1">
          {EDGE_KEYS.map((key) => (
            <FilterRow
              key={key}
              checked={filters.edges[key]}
              onChange={(v) => onChange({ edges: { [key]: v } })}
              label={t(`map.galaxy.edges.${key}`)}
            />
          ))}
        </div>
      </div>
      <div className="border-t border-border pt-2">
        <FilterRow
          checked={filters.hideOrphans}
          onChange={(v) => onChange({ hideOrphans: v })}
          label={t("map.galaxy.hideOrphans")}
        />
      </div>
    </div>
  );
}
