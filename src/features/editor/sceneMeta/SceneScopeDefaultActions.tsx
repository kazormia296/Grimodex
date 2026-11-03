import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  readScopeProjectDefault,
  type ScopeProjectDefault,
} from "@/lib/sceneScopeDefault";
import { applyScopeDefaultToScenes } from "@/features/scene-scope-default/applyScopeDefault";
import {
  describeScopeDefault,
  isMainLineAxes,
} from "@/features/scene-scope-default/describeDefault";
import type { Binding } from "./sceneScopeTypes";
// Registers this feature's lazy strings (DR-SDEF-52).
import "@/features/scene-scope-default/sceneScopeDefaultTranslations";

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * The project default as seen from one Scene's scope field (rev2 §7.3,
 * DR-SDEF-30, DR-SDEF-32): the badge for a Scene that matches the default (a
 * renderer comparison only, never stored), the note for a Scene outside the
 * main line, and "apply the default" for an unset or earlier Scene. Applying
 * loops the existing A1 writer for this one Scene.
 */
export function SceneScopeDefaultActions({
  workspacePath,
  binding,
  onApplied,
  hasUnsavedDraft = false,
}: {
  workspacePath: string;
  binding: Binding;
  onApplied: () => void | Promise<void>;
  /** The Scope field has unsaved edits that applying would discard. */
  hasUnsavedDraft?: boolean;
}) {
  const { t } = useTranslation();
  const [current, setCurrent] = useState<ScopeProjectDefault | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { projectId, sceneId } = binding;

  useEffect(() => {
    let live = true;
    setCurrent(null);
    setConfirming(false);
    setError(null);
    readScopeProjectDefault(workspacePath, projectId)
      .then((value) => {
        if (live) setCurrent(value);
      })
      .catch(() => {
        // An unreadable default only hides the badge and the action; the
        // settings screen reports it (DR-SDEF-29).
      });
    return () => {
      live = false;
    };
  }, [workspacePath, projectId, sceneId]);

  const value = current?.default;
  const explicit = binding.compatibilityMarker === "explicit";
  const matchesDefault =
    explicit &&
    value?.state === "set" &&
    sameJson(binding.queryIdentity, value.queryIdentity) &&
    sameJson(binding.materialConstraint, value.materialConstraint);
  const canApply = !explicit && value?.state === "set";
  // The default is named by its actual value (PR-2 review P2-2): "本筋" only
  // when it is the main line.
  const valueLabel =
    value?.state === "set" ? describeScopeDefault(value.queryIdentity, t) : "";
  // The note compares with the project default when there is one, otherwise
  // with the main line; a Scene equal to the default never gets it.
  const differsFromReference =
    explicit &&
    !matchesDefault &&
    (value?.state === "set"
      ? !sameJson(binding.queryIdentity, value.queryIdentity)
      : !isMainLineAxes(binding.queryIdentity));

  const apply = () => {
    setBusy(true);
    setError(null);
    void applyScopeDefaultToScenes({
      workspacePath,
      projectId,
      sceneIds: [sceneId],
      target:
        binding.compatibilityMarker === "legacy-absent"
          ? "legacy-absent"
          : "unknown",
      expectedVersion: current?.version,
    })
      .then(async (result) => {
        setConfirming(false);
        if (result.status === "no-default") {
          setError(t("settings.project.sceneScopeApplyNoDefault"));
        } else if (result.status === "default-changed") {
          setError(t("settings.project.sceneScopeDefaultConflict"));
        } else if (result.applied === 0) {
          setError(
            t("settings.project.sceneScopeApplyResult", {
              applied: result.applied,
              failed: result.failed,
            }),
          );
        } else {
          // The binding changed: the parent reads it again.
          await onApplied();
        }
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => setBusy(false));
  };

  return (
    <>
      {matchesDefault && (
        <span
          data-testid="scene-scope-default-badge"
          className="self-start rounded bg-primary/10 px-1.5 py-px text-[9px] font-bold text-primary"
        >
          {t("editor.sceneDetail.scopeDefaultBadge", { value: valueLabel })}
        </span>
      )}
      {differsFromReference && (
        <p
          data-testid="scene-scope-not-main-line"
          className="text-[10px] text-muted-foreground"
        >
          {value?.state === "set"
            ? t("editor.sceneDetail.scopeNotDefault", { value: valueLabel })
            : t("editor.sceneDetail.scopeNotMainLine")}
        </p>
      )}
      {canApply && !confirming && (
        <button
          type="button"
          data-testid="scene-scope-apply-default"
          onClick={() => setConfirming(true)}
          className="self-start rounded border border-border px-2 py-1 text-[10px] text-foreground hover:bg-accent"
        >
          {t("editor.sceneDetail.scopeApplyDefault")}
        </button>
      )}
      {canApply && confirming && (
        <div
          role="alertdialog"
          data-testid="scene-scope-apply-confirm"
          className="flex flex-col gap-1 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[10px] text-amber-950 dark:text-amber-100"
        >
          <p>
            {t("editor.sceneDetail.scopeApplyConfirm", { value: valueLabel })}
          </p>
          {hasUnsavedDraft && (
            <p data-testid="scene-scope-apply-unsaved-warning">
              {t("editor.sceneDetail.scopeApplyUnsavedWarning")}
            </p>
          )}
          {binding.compatibilityMarker === "legacy-absent" && (
            <p data-testid="scene-scope-apply-legacy-warning">
              {t("editor.sceneDetail.scopeApplyLegacyWarning")}
            </p>
          )}
          <div className="flex justify-end gap-1">
            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirming(false)}
              className="rounded px-2 py-0.5 hover:bg-accent disabled:opacity-50"
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              data-testid="scene-scope-apply-run"
              disabled={busy}
              onClick={apply}
              className="rounded border border-border px-2 py-0.5 hover:bg-accent disabled:opacity-50"
            >
              {t("editor.sceneDetail.scopeApplyRun")}
            </button>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="text-[10px] text-destructive">
          {error}
        </p>
      )}
    </>
  );
}
