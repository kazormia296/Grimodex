import { useTranslation } from "react-i18next";
import type { Binding, Constraint, Registry } from "./sceneScopeTypes";

const AXES = [
  ["timeline", "timelineRefs"],
  ["worldline", "worldlineRefs"],
  ["narrativeLayer", "narrativeLayerRefs"],
] as const;

function unresolved(): Constraint {
  return { kind: "unresolved", reason: "scene-scope-axis-unresolved" };
}

const ANY_OPTION = "kind:any";
const UNRESOLVED_OPTION = "kind:unresolved";
const EXACT_OPTION_PREFIX = "exact:";

function exactOption(ref: string): string {
  return `${EXACT_OPTION_PREFIX}${encodeURIComponent(ref)}`;
}

function constraintValue(value: Constraint): string {
  if (value.kind === "exact") return exactOption(value.ref);
  return value.kind === "any" ? ANY_OPTION : UNRESOLVED_OPTION;
}

function selectConstraint(value: string, refs: readonly string[]): Constraint {
  if (value === ANY_OPTION) return { kind: "any" };
  if (value === UNRESOLVED_OPTION) return unresolved();
  if (!value.startsWith(EXACT_OPTION_PREFIX)) return unresolved();
  let ref: string;
  try {
    ref = decodeURIComponent(value.slice(EXACT_OPTION_PREFIX.length));
  } catch {
    return unresolved();
  }
  return refs.includes(ref) ? { kind: "exact", ref } : unresolved();
}

function constraintOptions(refs: readonly string[], allowAny: boolean) {
  return [
    ...(allowAny ? [[ANY_OPTION, "Any"]] : []),
    [UNRESOLVED_OPTION, "Unresolved"],
    ...refs.map((ref) => [exactOption(ref), ref]),
  ];
}

function renderSelect(
  value: Constraint,
  refs: readonly string[],
  allowAny: boolean,
  onChange: (value: Constraint) => void,
) {
  return (
    <select
      value={constraintValue(value)}
      onChange={(event) => onChange(selectConstraint(event.target.value, refs))}
      className="min-w-0 flex-1 rounded border border-border bg-background px-1.5 py-1 text-[10px] text-foreground"
    >
      {constraintOptions(refs, allowAny).map(([option, label]) => (
        <option key={option} value={option}>
          {label}
        </option>
      ))}
    </select>
  );
}

function renderRow(
  label: string,
  query: Constraint,
  material: Constraint,
  refs: readonly string[],
  onQueryChange: (value: Constraint) => void,
  onMaterialChange: (value: Constraint) => void,
) {
  return (
    <div className="grid grid-cols-[64px_minmax(0,1fr)_minmax(0,1fr)] items-center gap-1.5">
      <span className="text-[10px] text-muted-foreground">{label}</span>
      {renderSelect(query, refs, false, onQueryChange)}
      {renderSelect(material, refs, true, onMaterialChange)}
    </div>
  );
}

export function SceneScopeFields({
  draft,
  registry,
  onAxisChange,
}: {
  draft: Binding;
  registry: Registry;
  onAxisChange: (
    group: "queryIdentity" | "materialConstraint",
    axis: "timeline" | "worldline" | "narrativeLayer",
    value: Constraint,
  ) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <div className="grid grid-cols-[64px_minmax(0,1fr)_minmax(0,1fr)] gap-1.5 text-[9px] text-muted-foreground">
        <span />
        <span>{t("editor.sceneDetail.queryIdentity", "Query")}</span>
        <span>{t("editor.sceneDetail.materialConstraint", "Material")}</span>
      </div>
      {AXES.map(([axis, refsKey]) => (
        <div key={axis}>
          {renderRow(
            axis === "narrativeLayer" ? "layer" : axis,
            draft.queryIdentity[axis],
            draft.materialConstraint[axis],
            registry[refsKey],
            (value) => onAxisChange("queryIdentity", axis, value),
            (value) => onAxisChange("materialConstraint", axis, value),
          )}
        </div>
      ))}
    </>
  );
}
