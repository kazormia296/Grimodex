import { useTranslation } from "react-i18next";
import type { Binding, Constraint, Registry } from "./sceneScopeTypes";
import { scopeRefLabel } from "@/features/scene-scope-default/describeDefault";

type Translate = (key: string) => string;

const AXES = [
  ["timeline", "timelineRefs", "editor.sceneDetail.axisTimeline"],
  ["worldline", "worldlineRefs", "editor.sceneDetail.axisWorldline"],
  ["narrativeLayer", "narrativeLayerRefs", "editor.sceneDetail.axisLayer"],
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

function constraintOptions(
  refs: readonly string[],
  allowAny: boolean,
  t: Translate,
) {
  return [
    ...(allowAny ? [[ANY_OPTION, t("editor.sceneDetail.constraintAny")]] : []),
    [UNRESOLVED_OPTION, t("editor.sceneDetail.constraintUnresolved")],
    ...refs.map((ref) => [exactOption(ref), scopeRefLabel(ref, t)]),
  ];
}

function renderSelect(
  value: Constraint,
  refs: readonly string[],
  allowAny: boolean,
  onChange: (value: Constraint) => void,
  t: Translate,
  disabled = false,
) {
  return (
    <select
      value={constraintValue(value)}
      disabled={disabled}
      onChange={(event) => onChange(selectConstraint(event.target.value, refs))}
      className="min-w-0 flex-1 rounded border border-border bg-background px-1.5 py-1 text-[10px] text-foreground disabled:opacity-60"
    >
      {constraintOptions(refs, allowAny, t).map(([option, label]) => (
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
  t: Translate,
  materialLocked: boolean,
) {
  return (
    <div className="grid grid-cols-[64px_minmax(0,1fr)_minmax(0,1fr)] items-center gap-1.5">
      <span className="text-[10px] text-muted-foreground">{label}</span>
      {renderSelect(query, refs, false, onQueryChange, t)}
      {renderSelect(material, refs, true, onMaterialChange, t, materialLocked)}
    </div>
  );
}

/**
 * The query and material selects of the three axes. While `materialLocked`,
 * the material column follows the query (rev2 §7.3, DR-SDEF-32) and is
 * shown read-only.
 */
export function SceneScopeFields({
  draft,
  registry,
  onAxisChange,
  materialLocked = false,
}: {
  draft: Binding;
  registry: Registry;
  materialLocked?: boolean;
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
      {AXES.map(([axis, refsKey, labelKey]) => (
        <div key={axis}>
          {renderRow(
            t(labelKey),
            draft.queryIdentity[axis],
            draft.materialConstraint[axis],
            registry[refsKey],
            (value) => onAxisChange("queryIdentity", axis, value),
            (value) => onAxisChange("materialConstraint", axis, value),
            t,
            materialLocked,
          )}
        </div>
      ))}
    </>
  );
}
