import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@/lib/tauri";
import { useTreeStore } from "@/features/tree/treeStore";
import { useWorkspaceStore } from "@/features/workspace/store";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { SceneScopeDefaultActions } from "@/features/editor/sceneMeta/SceneScopeDefaultActions";
import type {
  Binding,
  ScopeRead,
} from "@/features/editor/sceneMeta/sceneScopeTypes";
// Registers this feature's lazy strings (DR-SDEF-52).
import "@/features/scene-scope-default/sceneScopeDefaultTranslations";

function hasUnresolvedAxis(binding: Binding): boolean {
  return Object.values(binding.queryIdentity).some(
    (axis) => axis.kind === "unresolved",
  );
}

/**
 * Why no approved interpretation appears for an `unsupported-query` (rev2
 * §7.4, DR-SDEF-33). The wire reason is unchanged: this reads the active
 * Scene's own binding and names the Scope cause, with a way to set it. When
 * the binding cannot be read, or the cause is not the Scope, the existing
 * text stays.
 */
export default function RelatedScenesScopeGuidance({
  sceneId,
  fallback,
}: {
  sceneId: string;
  fallback: ReactNode;
}) {
  const { t } = useTranslation();
  const workspacePath = useWorkspaceStore((state) => state.activeWorkspacePath);
  const projectId = useTreeStore(
    (state) => state.nodes.find((node) => node.id === sceneId)?.projectId,
  );
  const [read, setRead] = useState<ScopeRead | null>(null);
  const [tick, setTick] = useState(0);
  const [applied, setApplied] = useState(false);

  useEffect(() => {
    let live = true;
    setRead(null);
    if (!workspacePath || !projectId) return;
    invoke<ScopeRead>("narrative_scene_scope_read", {
      expectedWorkspacePath: workspacePath,
      projectId,
      sceneId,
    })
      .then((value) => {
        if (live) setRead(value);
      })
      .catch(() => {
        // Unreadable: keep the existing text.
      });
    return () => {
      live = false;
    };
  }, [workspacePath, projectId, sceneId, tick]);

  const binding = read?.binding;
  const unset =
    binding?.compatibilityMarker === "unknown" ||
    binding?.compatibilityMarker === "legacy-absent";
  const unresolved =
    binding?.compatibilityMarker === "explicit" && hasUnresolvedAxis(binding);
  // DR-SDEF-38: the shown result belongs to the query made before the apply;
  // say when the new Scope takes effect instead of looking ineffective.
  if (applied && binding?.compatibilityMarker === "explicit")
    return (
      <p
        role="status"
        data-testid="nir1-scope-guidance-applied"
        className="px-3 py-2 text-[11px] text-muted-foreground"
      >
        {t("relatedScenes.scopeApplied")}
      </p>
    );
  if (!binding || !workspacePath || (!unset && !unresolved)) return fallback;

  const openScope = () =>
    useSettingsStore.getState().set("editor.sceneMetaPanelOpen", "true");
  return (
    <div
      data-testid="nir1-scope-guidance"
      className="flex flex-col gap-1 px-3 py-2 text-[11px] text-muted-foreground"
    >
      <p>
        {t(
          binding.compatibilityMarker === "unknown"
            ? "relatedScenes.scopeUnknown"
            : binding.compatibilityMarker === "legacy-absent"
              ? "relatedScenes.scopeLegacy"
              : "relatedScenes.scopeUnresolved",
        )}
      </p>
      <button
        type="button"
        data-testid="nir1-scope-guidance-open"
        onClick={openScope}
        className="self-start rounded border border-border px-2 py-0.5 text-[10px] text-foreground hover:bg-accent"
      >
        {t("relatedScenes.scopeOpen")}
      </button>
      {/* One click applies the default only to an unset Scene; an earlier
          Scene is irreversible and goes through the Scope field. */}
      {binding.compatibilityMarker === "unknown" && (
        <SceneScopeDefaultActions
          workspacePath={workspacePath}
          binding={binding}
          onApplied={() => {
            setApplied(true);
            setTick((value) => value + 1);
          }}
        />
      )}
    </div>
  );
}
