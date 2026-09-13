import { useEffect, useMemo, useRef, useState } from "react";
import { Save, Shield } from "lucide-react";
import { useTranslation } from "react-i18next";
import { invoke, isElectron } from "@/lib/tauri";
import { useWorkspaceStore } from "@/features/workspace/store";
import { useCodexStore } from "@/features/codex/codexStore";
import type { TreeNodeData } from "@/features/tree/treeStore";
import { SceneScopeFields } from "./SceneScopeFields";
import { SceneScopeRegistryEditor } from "./SceneScopeRegistryEditor";
import { SceneScopePrincipals } from "./SceneScopePrincipals";
import type {
  Binding,
  Constraint,
  RegistryUpdate,
  ScopeRead,
  ScopeUpdate,
} from "./sceneScopeTypes";

type SceneScopeIdentity = {
  workspacePath: string | null;
  projectId: string;
  sceneId: string;
};

function sameIdentity(
  left: SceneScopeIdentity,
  right: SceneScopeIdentity,
): boolean {
  return (
    left.workspacePath === right.workspacePath &&
    left.projectId === right.projectId &&
    left.sceneId === right.sceneId
  );
}

function describeConstraint(value: Constraint): string {
  if (value.kind === "exact") return value.ref;
  if (value.kind === "unresolved") return `unresolved:${value.reason}`;
  return value.kind;
}

function describePrincipal(value: Binding["knowledgeHolder"]): string {
  return value.kind === "character" ? `character:${value.ref}` : value.kind;
}

function describeBindingScope(binding: Binding): string {
  return [
    `query.timeline=${describeConstraint(binding.queryIdentity.timeline)}`,
    `query.worldline=${describeConstraint(binding.queryIdentity.worldline)}`,
    `query.layer=${describeConstraint(binding.queryIdentity.narrativeLayer)}`,
    `material.timeline=${describeConstraint(binding.materialConstraint.timeline)}`,
    `material.worldline=${describeConstraint(binding.materialConstraint.worldline)}`,
    `material.layer=${describeConstraint(binding.materialConstraint.narrativeLayer)}`,
    `holder=${describePrincipal(binding.knowledgeHolder)}`,
    `audience=${describePrincipal(binding.audience)}`,
  ].join(" · ");
}

function describeRegistry(registry: ScopeRead["registry"]): string {
  const describeRefs = (refs: string[]) =>
    refs.length ? refs.join(",") : "none";
  return [
    `timelineRefs=${describeRefs(registry.timelineRefs)}`,
    `worldlineRefs=${describeRefs(registry.worldlineRefs)}`,
    `narrativeLayerRefs=${describeRefs(registry.narrativeLayerRefs)}`,
  ].join(" · ");
}

/** Native-only editor for the small A1 scene-scope binding. */
export function SceneScopeEditor({ node }: { node: TreeNodeData }) {
  const { t } = useTranslation();
  const workspacePath = useWorkspaceStore((state) => state.activeWorkspacePath);
  const entries = useCodexStore((state) => state.entries);
  const [read, setRead] = useState<ScopeRead | null>(null);
  const [draft, setDraft] = useState<Binding | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflictSnapshot, setConflictSnapshot] = useState<ScopeRead | null>(
    null,
  );
  const requestEpoch = useRef(0);
  const draftRef = useRef<Binding | null>(null);
  const identityRef = useRef<SceneScopeIdentity>({
    workspacePath,
    projectId: node.projectId,
    sceneId: node.id,
  });
  const identity: SceneScopeIdentity = {
    workspacePath,
    projectId: node.projectId,
    sceneId: node.id,
  };
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);
  // Render-time identity update closes the gap before React runs the effect
  // cleanup when navigation is deferred by the host.
  identityRef.current = identity;

  const characters = useMemo(
    () =>
      entries.filter(
        (entry) =>
          entry.type === "character" && entry.projectId === node.projectId,
      ),
    [entries, node.projectId],
  );

  useEffect(() => {
    const epoch = ++requestEpoch.current;
    const requestIdentity: SceneScopeIdentity = {
      workspacePath,
      projectId: node.projectId,
      sceneId: node.id,
    };
    const isCurrent = () =>
      requestEpoch.current === epoch &&
      sameIdentity(identityRef.current, requestIdentity);
    if (!isElectron()) return;
    if (!workspacePath) {
      if (isCurrent()) {
        setRead(null);
        setDraft(null);
        setLoading(false);
        setConflictSnapshot(null);
      }
      return;
    }
    // Do not leave the previous scene's binding actionable while the Native
    // read for the newly selected scene is in flight.
    setRead(null);
    setDraft(null);
    setLoading(true);
    setError(null);
    setConflictSnapshot(null);
    void invoke<ScopeRead>("narrative_scene_scope_read", {
      expectedWorkspacePath: workspacePath,
      projectId: node.projectId,
      sceneId: node.id,
    })
      .then((value) => {
        if (!isCurrent()) return;
        setRead(value);
        setDraft(value.binding);
      })
      .catch((cause: unknown) => {
        if (isCurrent()) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      })
      .finally(() => {
        if (isCurrent()) setLoading(false);
      });
    return () => {
      if (requestEpoch.current === epoch) requestEpoch.current += 1;
    };
  }, [node.id, node.projectId, workspacePath]);

  if (!isElectron()) return null;

  const updateAxis = (
    group: "queryIdentity" | "materialConstraint",
    axis: "timeline" | "worldline" | "narrativeLayer",
    value: Constraint,
  ) => {
    if (loading || saving) return;
    setDraft((current) =>
      current
        ? { ...current, [group]: { ...current[group], [axis]: value } }
        : current,
    );
  };

  const scopeControlsDisabled = loading || saving;

  const save = () => {
    if (!draft || !workspacePath || scopeControlsDisabled) return;
    const epoch = requestEpoch.current;
    const requestIdentity = identity;
    const isCurrent = () =>
      requestEpoch.current === epoch &&
      sameIdentity(identityRef.current, requestIdentity);
    setSaving(true);
    setError(null);
    setConflictSnapshot(null);
    const now = new Date().toISOString();
    void invoke<ScopeUpdate>("narrative_scene_scope_update", {
      expectedWorkspacePath: workspacePath,
      payload: {
        projectId: draft.projectId,
        sceneId: draft.sceneId,
        requestId: crypto.randomUUID(),
        sessionId: crypto.randomUUID(),
        eventUid: crypto.randomUUID(),
        baseVersion: draft.version,
        updatedAt: now,
        scope: {
          schemaVersion: 1,
          compatibilityMarker: "explicit",
          queryIdentity: draft.queryIdentity,
          materialConstraint: draft.materialConstraint,
          knowledgeHolder: draft.knowledgeHolder,
          audience: draft.audience,
        },
      },
    })
      .then((value) => {
        if (!isCurrent()) return;
        // A binding write does not change the registry. Keep its object
        // identity so the registry editor preserves an unsaved local draft.
        setRead((current) =>
          current ? { ...current, binding: value.binding } : current,
        );
        setDraft(value.binding);
        setConflictSnapshot(null);
      })
      .catch((cause: unknown) => {
        if (!isCurrent()) return;
        const message = cause instanceof Error ? cause.message : String(cause);
        if (!message.includes("NEX_SCENE_SCOPE_VERSION_MISMATCH")) {
          setError(message);
          return;
        }
        const preservedDraft = draftRef.current ?? draft;
        if (!preservedDraft || !requestIdentity.workspacePath) {
          setError(message);
          return;
        }
        setLoading(true);
        setConflictSnapshot(null);
        void invoke<ScopeRead>("narrative_scene_scope_read", {
          expectedWorkspacePath: requestIdentity.workspacePath,
          projectId: requestIdentity.projectId,
          sceneId: requestIdentity.sceneId,
        })
          .then((fresh) => {
            if (!isCurrent()) return;
            // Adopt only Native's current OCC identity. Keep every local
            // scope field so a concurrent writer is never silently copied
            // over the user's unsaved draft.
            // This is binding-only recovery. Keep the existing registry object
            // so the registry editor does not reset its unsaved local draft.
            setRead((current) =>
              current
                ? {
                    ...current,
                    registryRevision: fresh.registryRevision,
                    registrySourceToken: fresh.registrySourceToken,
                    registryUpdatedAt: fresh.registryUpdatedAt,
                    binding: fresh.binding,
                  }
                : fresh,
            );
            setConflictSnapshot(fresh);
            setDraft({
              ...fresh.binding,
              compatibilityMarker: preservedDraft.compatibilityMarker,
              queryIdentity: preservedDraft.queryIdentity,
              materialConstraint: preservedDraft.materialConstraint,
              knowledgeHolder: preservedDraft.knowledgeHolder,
              audience: preservedDraft.audience,
            });
            setError(
              t(
                "editor.sceneDetail.scopeConflict",
                "Scene scope changed while you were editing. Review your draft and save again.",
              ),
            );
          })
          .catch((refreshCause: unknown) => {
            if (!isCurrent()) return;
            setError(
              refreshCause instanceof Error
                ? refreshCause.message
                : String(refreshCause),
            );
          })
          .finally(() => {
            if (isCurrent()) setLoading(false);
          });
      })
      .finally(() => {
        if (isCurrent()) setSaving(false);
      });
  };

  return (
    <div
      data-testid="scene-scope-editor"
      className="flex flex-col gap-1.5 border-b border-border px-3 py-2"
    >
      <div className="flex items-center gap-1.5">
        <Shield size={11} aria-hidden className="text-muted-foreground" />
        <span className="text-[10px] font-semibold text-foreground">
          {t("editor.sceneDetail.scope", "Scope")}
        </span>
        {draft && (
          <span className="ms-auto text-[9px] text-muted-foreground">
            {draft.compatibilityMarker} · v{draft.version}
          </span>
        )}
      </div>
      {loading && (
        <span className="text-[10px] text-muted-foreground">
          {t("common.loading", "Loading…")}
        </span>
      )}
      {error && (
        <div
          role="alert"
          className={
            conflictSnapshot
              ? "rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[10px] text-amber-950 dark:text-amber-100"
              : "text-[10px] text-destructive"
          }
        >
          <div>{error}</div>
          {conflictSnapshot && (
            <div
              data-testid="scene-scope-conflict-fresh"
              className="mt-1 break-words"
            >
              <div>
                {t(
                  "editor.sceneDetail.scopeConflictCurrent",
                  "Current Native scope",
                )}
                : {describeBindingScope(conflictSnapshot.binding)}
              </div>
              <div data-testid="scene-scope-conflict-fresh-registry">
                {t(
                  "editor.sceneDetail.scopeConflictCurrentRegistry",
                  "Current Native registry",
                )}
                : {describeRegistry(conflictSnapshot.registry)}
              </div>
            </div>
          )}
        </div>
      )}
      {draft && read && workspacePath && (
        <fieldset
          data-testid="scene-scope-controls"
          disabled={scopeControlsDisabled}
          className="contents"
        >
          <SceneScopeRegistryEditor
            projectId={node.projectId}
            sceneId={node.id}
            workspacePath={workspacePath}
            registry={read.registry}
            registryRevision={read.registryRevision}
            onSaved={async (_update: RegistryUpdate) => {
              const refreshEpoch = requestEpoch.current;
              const refreshIdentity = identity;
              const isCurrentRefresh = () =>
                requestEpoch.current === refreshEpoch &&
                sameIdentity(identityRef.current, refreshIdentity);
              if (!isCurrentRefresh() || !refreshIdentity.workspacePath) return;
              // The registry write invalidates the binding snapshot immediately.
              // Hide both writers until a matching fresh read succeeds; an old
              // OCC version must never remain actionable after this boundary.
              setRead(null);
              setDraft(null);
              setLoading(true);
              setError(null);
              try {
                const fresh = await invoke<ScopeRead>(
                  "narrative_scene_scope_read",
                  {
                    expectedWorkspacePath: refreshIdentity.workspacePath,
                    projectId: refreshIdentity.projectId,
                    sceneId: refreshIdentity.sceneId,
                  },
                );
                if (!isCurrentRefresh()) return;
                // Replace the read and draft from one Native snapshot so the
                // next binding update carries the current OCC version.
                setRead(fresh);
                setDraft(fresh.binding);
              } catch (cause: unknown) {
                if (isCurrentRefresh()) {
                  setRead(null);
                  setDraft(null);
                  setError(
                    cause instanceof Error ? cause.message : String(cause),
                  );
                }
              } finally {
                if (isCurrentRefresh()) setLoading(false);
              }
            }}
          />
          <SceneScopeFields
            draft={draft}
            registry={read.registry}
            onAxisChange={updateAxis}
          />
          <SceneScopePrincipals
            knowledgeHolder={draft.knowledgeHolder}
            audience={draft.audience}
            characters={characters}
            onChange={(field, value) => {
              if (scopeControlsDisabled) return;
              setDraft({ ...draft, [field]: value });
            }}
          />
          <button
            type="button"
            data-testid="scene-scope-binding-save"
            onClick={save}
            disabled={saving || loading}
            className="ms-auto inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-[10px] text-foreground hover:bg-accent disabled:opacity-50"
          >
            <Save size={10} aria-hidden />
            {saving ? t("common.saving", "Saving…") : t("common.save", "Save")}
          </button>
        </fieldset>
      )}
    </div>
  );
}
