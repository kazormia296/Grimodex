import { useEffect, useRef, useState } from "react";
import { Plus, Save, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { invoke } from "@/lib/tauri";
import type { Registry, RegistryUpdate } from "./sceneScopeTypes";

const AXES = [
  ["timelineRefs", "Timeline", "timeline:main"],
  ["worldlineRefs", "Worldline", "worldline:prime"],
  ["narrativeLayerRefs", "Layer", "layer:manuscript"],
] as const;

type Axis = (typeof AXES)[number][0];

function normalizeRefs(refs: string[]): string[] {
  return refs.map((ref) => ref.trim()).filter(Boolean);
}

function normalizedRegistry(registry: Registry): Registry {
  return {
    ...registry,
    timelineRefs: normalizeRefs(registry.timelineRefs),
    worldlineRefs: normalizeRefs(registry.worldlineRefs),
    narrativeLayerRefs: normalizeRefs(registry.narrativeLayerRefs),
  };
}

/** Small Native-OCC editor for the project scope vocabulary used by scenes. */
export function SceneScopeRegistryEditor({
  projectId,
  sceneId,
  workspacePath,
  registry,
  registryRevision,
  onSaved,
}: {
  projectId: string;
  sceneId: string;
  workspacePath: string;
  registry: Registry;
  registryRevision: number;
  onSaved: (update: RegistryUpdate) => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<Registry>(registry);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestEpoch = useRef(0);
  const identityRef = useRef({ workspacePath, projectId, sceneId });
  identityRef.current = { workspacePath, projectId, sceneId };

  useEffect(() => setDraft(registry), [registry]);

  useEffect(() => {
    const epoch = ++requestEpoch.current;
    setSaving(false);
    setError(null);
    return () => {
      if (requestEpoch.current === epoch) requestEpoch.current += 1;
    };
  }, [workspacePath, projectId, sceneId]);

  const updateRef = (axis: Axis, index: number, value: string) => {
    setDraft((current) => ({
      ...current,
      [axis]: current[axis].map((ref, refIndex) =>
        refIndex === index ? value : ref,
      ),
    }));
  };

  const addRef = (axis: Axis) => {
    setDraft((current) => ({ ...current, [axis]: [...current[axis], ""] }));
  };

  const removeRef = (axis: Axis, index: number) => {
    setDraft((current) => ({
      ...current,
      [axis]: current[axis].filter((_, refIndex) => refIndex !== index),
    }));
  };

  const save = () => {
    if (saving) return;
    const epoch = requestEpoch.current;
    const requestIdentity = { workspacePath, projectId, sceneId };
    const isCurrent = () =>
      requestEpoch.current === epoch &&
      identityRef.current.workspacePath === requestIdentity.workspacePath &&
      identityRef.current.projectId === requestIdentity.projectId &&
      identityRef.current.sceneId === requestIdentity.sceneId;
    const next = normalizedRegistry(draft);
    for (const [axis, label] of AXES) {
      const refs = next[axis];
      if (new Set(refs).size !== refs.length) {
        setError(`${label} refs must be unique`);
        return;
      }
    }
    setSaving(true);
    setError(null);
    void invoke<RegistryUpdate>("narrative_scene_scope_registry_update", {
      expectedWorkspacePath: workspacePath,
      payload: {
        projectId,
        requestId: crypto.randomUUID(),
        sessionId: crypto.randomUUID(),
        eventUid: crypto.randomUUID(),
        baseVersion: registryRevision,
        updatedAt: new Date().toISOString(),
        registry: next,
      },
    })
      .then((update) => {
        if (!isCurrent()) return;
        setDraft(update.registry);
        return onSaved(update);
      })
      .catch((cause: unknown) => {
        if (!isCurrent()) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (isCurrent()) setSaving(false);
      });
  };

  return (
    <details
      data-testid="scene-scope-registry-editor"
      className="rounded border border-border px-2 py-1"
    >
      <summary className="cursor-pointer text-[10px] text-muted-foreground">
        {t("editor.sceneDetail.scopeRegistry", "Scope registry")} · v
        {registryRevision}
      </summary>
      <div className="mt-1.5 flex flex-col gap-1.5">
        <span className="text-[9px] text-muted-foreground">
          {draft.registryVersion}
        </span>
        {AXES.map(([axis, label, placeholder]) => (
          <div key={axis} className="flex flex-col gap-1">
            <span className="text-[9px] text-muted-foreground">{label}</span>
            {draft[axis].map((ref, index) => (
              <div key={`${axis}-${index}`} className="flex items-center gap-1">
                <input
                  aria-label={`${label} ref ${index + 1}`}
                  value={ref}
                  placeholder={placeholder}
                  onChange={(event) =>
                    updateRef(axis, index, event.target.value)
                  }
                  className="min-w-0 flex-1 rounded border border-border bg-background px-1.5 py-1 text-[10px] text-foreground"
                />
                <button
                  type="button"
                  aria-label={`Remove ${label} ref ${index + 1}`}
                  onClick={() => removeRef(axis, index)}
                  className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <Trash2 size={11} aria-hidden />
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => addRef(axis)}
              className="inline-flex items-center gap-1 self-start rounded px-1 py-0.5 text-[9px] text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <Plus size={10} aria-hidden />
              {t("common.add", "Add")}
            </button>
          </div>
        ))}
        {error && <span className="text-[10px] text-destructive">{error}</span>}
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="ms-auto inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-[10px] text-foreground hover:bg-accent disabled:opacity-50"
        >
          <Save size={10} aria-hidden />
          {saving ? t("common.saving", "Saving…") : t("common.save", "Save")}
        </button>
      </div>
    </details>
  );
}
