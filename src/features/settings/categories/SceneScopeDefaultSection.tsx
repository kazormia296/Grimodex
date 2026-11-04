import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { invoke } from "@/lib/tauri";
import {
  MAIN_LINE_REFS,
  readScopeProjectDefault,
  scopeDefaultAxes,
  updateScopeProjectDefault,
  type ScopeProjectDefault,
} from "@/lib/sceneScopeDefault";
import { useTreeStore } from "@/features/tree/treeStore";
import { scopeRefLabel } from "@/features/scene-scope-default/describeDefault";
import type { ScopeRead } from "@/features/editor/sceneMeta/sceneScopeTypes";
import { ScopeDefaultApplyPanel } from "@/features/scene-scope-default/ScopeDefaultApplyPanel";
import { SettingSection } from "../components/SettingSection";
import { SettingRow } from "../components/SettingRow";
// Registers this feature's lazy strings (DR-SDEF-52).
import "@/features/scene-scope-default/sceneScopeDefaultTranslations";

type Axis = keyof typeof MAIN_LINE_REFS;
type Refs = Record<Axis, string>;

const AXES: readonly [Axis, keyof ScopeRead["registry"], string][] = [
  ["timeline", "timelineRefs", "editor.sceneDetail.axisTimeline"],
  ["worldline", "worldlineRefs", "editor.sceneDetail.axisWorldline"],
  ["narrativeLayer", "narrativeLayerRefs", "editor.sceneDetail.axisLayer"],
];

type LoadState =
  | { kind: "loading" }
  | { kind: "invalid" }
  | { kind: "error"; message: string }
  | { kind: "ready"; current: ScopeProjectDefault };

/** Maps a writer failure to the author's words (DR-SDEF-29). */
function writeErrorKey(message: string): string | null {
  if (message.includes("NEX_SCENE_SCOPE_AUTHORITY_UNAVAILABLE"))
    return "settings.project.sceneScopeNoVocabulary";
  if (message.includes("NEX_SCENE_SCOPE_DEFAULT_REF_UNREGISTERED"))
    return "settings.project.sceneScopeRefUnregistered";
  if (message.includes("NEX_SCENE_SCOPE_DEFAULT_VERSION_MISMATCH"))
    return "settings.project.sceneScopeDefaultConflict";
  return null;
}

/**
 * Settings > Project: the project's Scene Scope default (SDEF/1 R16, R19;
 * rev2 §7.1; DR-SDEF-29). Choosing calls only the default writer, which
 * invalidates nothing (R17). Applying it to existing Scenes is the separate
 * panel below (R18). The vocabulary comes from one Scene's scope read; a
 * project without Scenes offers the main line only.
 */
export function SceneScopeDefaultSection({
  workspacePath,
  projectId,
}: {
  workspacePath: string;
  projectId: string;
}) {
  const { t } = useTranslation();
  const nodes = useTreeStore((state) => state.nodes);
  const sceneIds = useMemo(
    () =>
      nodes
        .filter(
          (node) => node.nodeType === "scene" && node.projectId === projectId,
        )
        .map((node) => node.id),
    [nodes, projectId],
  );
  const firstSceneId = sceneIds[0] ?? null;
  const [load, setLoad] = useState<LoadState>({ kind: "loading" });
  const [registry, setRegistry] = useState<ScopeRead["registry"] | null>(null);
  const [useDefault, setUseDefault] = useState(false);
  const [refs, setRefs] = useState<Refs>({ ...MAIN_LINE_REFS });
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    let live = true;
    setLoad({ kind: "loading" });
    readScopeProjectDefault(workspacePath, projectId)
      .then((current) => {
        if (!live) return;
        setLoad({ kind: "ready", current });
        setUseDefault(current.default.state === "set");
        if (current.default.state === "set") {
          const query = current.default.queryIdentity;
          setRefs({
            timeline: query.timeline.ref,
            worldline: query.worldline.ref,
            narrativeLayer: query.narrativeLayer.ref,
          });
        }
      })
      .catch((cause: unknown) => {
        if (!live) return;
        const message = cause instanceof Error ? cause.message : String(cause);
        // A broken row (PR-1 P3-1) is shown, not repaired: there is no
        // recovery writer (DR-SDEF-29).
        setLoad(
          message.includes("NEX_SCENE_SCOPE_DEFAULT_INVALID")
            ? { kind: "invalid" }
            : { kind: "error", message },
        );
      });
    return () => {
      live = false;
    };
  }, [workspacePath, projectId, reloadTick]);

  useEffect(() => {
    let live = true;
    setRegistry(null);
    if (!firstSceneId) return;
    invoke<ScopeRead>("narrative_scene_scope_read", {
      expectedWorkspacePath: workspacePath,
      projectId,
      sceneId: firstSceneId,
    })
      .then((read) => {
        if (live) setRegistry(read.registry);
      })
      .catch(() => {
        // Without the vocabulary the main line stays the only choice.
      });
    return () => {
      live = false;
    };
  }, [workspacePath, projectId, firstSceneId]);

  const optionsFor = (axis: Axis, registryKey: keyof ScopeRead["registry"]) => {
    const fromRegistry = registry?.[registryKey];
    const list = Array.isArray(fromRegistry)
      ? fromRegistry
      : [MAIN_LINE_REFS[axis]];
    return list.includes(refs[axis]) ? list : [...list, refs[axis]];
  };
  const unregistered =
    registry !== null &&
    AXES.some(([axis, key]) => {
      const list = registry[key];
      return Array.isArray(list) && !list.includes(refs[axis]);
    });

  const save = () => {
    if (load.kind !== "ready" || saving) return;
    setSaving(true);
    setNotice(null);
    void updateScopeProjectDefault(workspacePath, {
      projectId,
      baseVersion: load.current.version,
      default: useDefault
        ? {
            state: "set",
            queryIdentity: scopeDefaultAxes(refs),
            materialConstraint: scopeDefaultAxes(refs),
          }
        : { state: "none" },
    })
      .then((current) => {
        setLoad({ kind: "ready", current });
        toast.success(t("settings.project.sceneScopeDefaultSaved"));
      })
      .catch((cause: unknown) => {
        const message = cause instanceof Error ? cause.message : String(cause);
        const key = writeErrorKey(message);
        setNotice(key ? t(key) : message);
        if (key === "settings.project.sceneScopeDefaultConflict")
          setReloadTick((tick) => tick + 1);
      })
      .finally(() => setSaving(false));
  };

  const savedSet =
    load.kind === "ready" && load.current.default.state === "set";
  // PR-2 review P2-1: while the form differs from the saved default, the
  // apply buttons would apply the saved value, not the shown one. Stop them
  // until the form is saved (or put back).
  const formDiffers =
    load.kind === "ready" &&
    (load.current.default.state === "set"
      ? !useDefault ||
        AXES.some(
          ([axis]) =>
            load.current.default.state === "set" &&
            load.current.default.queryIdentity[axis].ref !== refs[axis],
        )
      : useDefault);

  return (
    <SettingSection title={t("settings.project.sceneScopeDefault")}>
      <div data-testid="scene-scope-default-section" className="space-y-3">
        <p className="text-xs text-muted-foreground">
          {t("settings.project.sceneScopeDefaultHint")}
        </p>
        {load.kind === "loading" && (
          <p className="text-xs text-muted-foreground">{t("common.loading")}</p>
        )}
        {load.kind === "invalid" && (
          <p
            role="alert"
            data-testid="scene-scope-default-invalid"
            className="text-xs text-destructive"
          >
            {t("settings.project.sceneScopeDefaultInvalid")}
          </p>
        )}
        {load.kind === "error" && (
          <p role="alert" className="text-xs text-destructive">
            {load.message}
          </p>
        )}
        {load.kind === "ready" && (
          <>
            <SettingRow label={t("settings.project.sceneScopeDefault")}>
              <select
                data-testid="scene-scope-default-mode"
                value={useDefault ? "set" : "none"}
                onChange={(event) =>
                  setUseDefault(event.target.value === "set")
                }
                className="rounded-md border border-input bg-background px-2 py-1 text-sm focus:outline-none"
              >
                <option value="none">
                  {t("settings.project.sceneScopeDefaultNone")}
                </option>
                <option value="set">
                  {t("settings.project.sceneScopeDefaultSet")}
                </option>
              </select>
            </SettingRow>
            {useDefault &&
              AXES.map(([axis, key, labelKey]) => (
                <SettingRow key={axis} label={t(labelKey)}>
                  <select
                    data-testid={`scene-scope-default-${axis}`}
                    value={refs[axis]}
                    onChange={(event) =>
                      setRefs((current) => ({
                        ...current,
                        [axis]: event.target.value,
                      }))
                    }
                    className="rounded-md border border-input bg-background px-2 py-1 text-sm focus:outline-none"
                  >
                    {optionsFor(axis, key).map((ref) => (
                      <option key={ref} value={ref}>
                        {scopeRefLabel(ref, t)}
                      </option>
                    ))}
                  </select>
                </SettingRow>
              ))}
            {useDefault && unregistered && (
              <p
                role="status"
                data-testid="scene-scope-default-registry-warning"
                className="text-xs text-amber-700 dark:text-amber-300"
              >
                {t("settings.project.sceneScopeRegistryWarning")}
              </p>
            )}
            <div className="flex justify-end">
              <button
                type="button"
                data-testid="scene-scope-default-save"
                disabled={saving || (useDefault && unregistered)}
                onClick={save}
                className="rounded-md border border-border px-3 py-1 text-sm hover:bg-accent disabled:opacity-50"
              >
                {t("settings.project.sceneScopeDefaultSave")}
              </button>
            </div>
            {notice && (
              <p
                role="alert"
                data-testid="scene-scope-default-notice"
                className="text-xs text-destructive"
              >
                {notice}
              </p>
            )}
            {savedSet && formDiffers && (
              <p
                role="status"
                data-testid="scene-scope-default-unsaved"
                className="text-xs text-muted-foreground"
              >
                {t("settings.project.sceneScopeApplyNeedsSave")}
              </p>
            )}
            <ScopeDefaultApplyPanel
              workspacePath={workspacePath}
              projectId={projectId}
              sceneIds={sceneIds}
              allowLegacy
              disabled={!savedSet || formDiffers}
            />
          </>
        )}
      </div>
    </SettingSection>
  );
}
