import { useState } from "react";
import { useTranslation } from "react-i18next";
import { readScopeProjectDefault } from "@/lib/sceneScopeDefault";
import {
  applyScopeDefaultToScenes,
  countScopeMarkers,
  type ScopeApplyResult,
  type ScopeApplyTarget,
} from "./applyScopeDefault";
import { describeScopeDefault } from "./describeDefault";
// Registers this feature's lazy strings (DR-SDEF-52).
import "./sceneScopeDefaultTranslations";

type Phase =
  | { kind: "idle" }
  | { kind: "counting"; target: ScopeApplyTarget }
  | {
      kind: "confirm";
      target: ScopeApplyTarget;
      count: number;
      /** The saved default the author is asked about (PR-2 review P2-1). */
      value: string;
      version: number;
    }
  | { kind: "running"; target: ScopeApplyTarget }
  | { kind: "message"; text: string };

/**
 * "Apply the default to unset scenes" for a set of Scenes (a chapter or the
 * whole project; SDEF/1 R16, R18; DR-SDEF-30). It counts the targets first,
 * asks with the count and the invalidation, then loops the existing A1 writer
 * and shows how many Scenes were and were not applied. Earlier
 * (`legacy-absent`) Scenes are a separate button with its own warning.
 */
export function ScopeDefaultApplyPanel({
  workspacePath,
  projectId,
  sceneIds,
  allowLegacy = false,
  disabled = false,
  onApplied,
}: {
  workspacePath: string;
  projectId: string;
  sceneIds: readonly string[];
  allowLegacy?: boolean;
  disabled?: boolean;
  onApplied?: () => void;
}) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const busy = phase.kind === "counting" || phase.kind === "running";

  const start = (target: ScopeApplyTarget) => {
    setPhase({ kind: "counting", target });
    void Promise.all([
      readScopeProjectDefault(workspacePath, projectId),
      countScopeMarkers({ workspacePath, projectId, sceneIds }),
    ])
      .then(([current, counts]) => {
        if (current.default.state !== "set") {
          setPhase({
            kind: "message",
            text: t("settings.project.sceneScopeApplyNoDefault"),
          });
          return;
        }
        const count =
          target === "unknown" ? counts.unknown : counts.legacyAbsent;
        setPhase(
          count === 0
            ? {
                kind: "message",
                text: t("settings.project.sceneScopeApplyNone"),
              }
            : {
                kind: "confirm",
                target,
                count,
                value: describeScopeDefault(current.default.queryIdentity, t),
                version: current.version,
              },
        );
      })
      .catch((cause: unknown) =>
        setPhase({
          kind: "message",
          text: cause instanceof Error ? cause.message : String(cause),
        }),
      );
  };

  const run = (target: ScopeApplyTarget, expectedVersion: number) => {
    setPhase({ kind: "running", target });
    void applyScopeDefaultToScenes({
      workspacePath,
      projectId,
      sceneIds,
      target,
      expectedVersion,
    })
      .then((result: ScopeApplyResult) => {
        if (result.status !== "done") {
          setPhase({
            kind: "message",
            text: t(
              result.status === "no-default"
                ? "settings.project.sceneScopeApplyNoDefault"
                : "settings.project.sceneScopeDefaultConflict",
            ),
          });
          return;
        }
        setPhase({
          kind: "message",
          text: t("settings.project.sceneScopeApplyResult", {
            applied: result.applied,
            failed: result.failed,
          }),
        });
        if (result.applied > 0) onApplied?.();
      })
      .catch((cause: unknown) =>
        setPhase({
          kind: "message",
          text: cause instanceof Error ? cause.message : String(cause),
        }),
      );
  };

  const button = (target: ScopeApplyTarget, label: string, testId: string) => (
    <button
      type="button"
      data-testid={testId}
      disabled={disabled || busy}
      onClick={() => start(target)}
      className="rounded-md border border-border px-3 py-1 text-sm hover:bg-accent disabled:opacity-50"
    >
      {label}
    </button>
  );

  return (
    <div className="flex flex-col gap-2" data-testid="scope-default-apply">
      <div className="flex flex-wrap gap-2">
        {button(
          "unknown",
          t("settings.project.sceneScopeApplyUnset"),
          "scope-default-apply-unset",
        )}
        {allowLegacy &&
          button(
            "legacy-absent",
            t("settings.project.sceneScopeApplyLegacy"),
            "scope-default-apply-legacy",
          )}
      </div>
      {phase.kind === "confirm" && (
        <div
          role="alertdialog"
          data-testid="scope-default-apply-confirm"
          className="flex flex-col gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-950 dark:text-amber-100"
        >
          <p>
            {t("settings.project.sceneScopeApplyConfirm", {
              count: phase.count,
              value: phase.value,
            })}
          </p>
          {phase.target === "legacy-absent" && (
            <p>{t("editor.sceneDetail.scopeApplyLegacyWarning")}</p>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setPhase({ kind: "idle" })}
              className="rounded px-2 py-0.5 hover:bg-accent"
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              data-testid="scope-default-apply-run"
              disabled={disabled}
              onClick={() => run(phase.target, phase.version)}
              className="rounded border border-border px-2 py-0.5 hover:bg-accent disabled:opacity-50"
            >
              {t("editor.sceneDetail.scopeApplyRun")}
            </button>
          </div>
        </div>
      )}
      {phase.kind === "message" && (
        <p
          role="status"
          data-testid="scope-default-apply-message"
          className="text-xs text-muted-foreground"
        >
          {phase.text}
        </p>
      )}
    </div>
  );
}
