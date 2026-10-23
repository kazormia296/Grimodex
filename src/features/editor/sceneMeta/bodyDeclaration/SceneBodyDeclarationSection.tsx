/**
 * The Scene body declaration panel (CB-3).
 *
 * It shows which of three states the Scene is in: a draft (nothing stored yet,
 * only what the author is confirming on this screen), declared (a stored
 * declaration, including one that has expired) and currently effective (the
 * stored declaration still holds). Native decides "effective"; this panel only
 * writes it down, and it never shows "effective" while a read is loading,
 * failed or unknown.
 *
 * It does not build an approval of its own. Pressing declare asks Main to open
 * its confirmation dialog, which is the only place a declaration is approved;
 * revoking needs no confirmation. Every message comes from a closed code, and
 * no raw error text, excerpt, body, digest or token is rendered. While the
 * product UI constant is off the hook does nothing and this renders nothing.
 */
import { useEffect, useRef, useState } from "react";
import { Info, LoaderCircle, ShieldAlert, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TreeNodeData } from "@/features/tree/treeStore";
import {
  BODY_DECLARATION_AXES,
  BODY_DECLARATION_REFUSAL_CODES,
  type BodyDeclarationAxis,
  type BodyDeclarationRefusalCode,
  type BodyDeclarationSnapshot,
  type ConfirmedAxes,
} from "./bodyDeclarationTypes";
import {
  useSceneBodyDeclaration,
  type BodyDeclarationOutcome,
} from "./useSceneBodyDeclaration";
import {
  hasUnsavedSceneEdits,
  useUnsavedSceneEdits,
} from "./useUnsavedSceneEdits";

const PREFIX = "editor.sceneDetail.bodyDeclaration";
const KNOWN_CODES: ReadonlySet<string> = new Set(
  BODY_DECLARATION_REFUSAL_CODES,
);

const NOTHING_CONFIRMED: ConfirmedAxes = Object.freeze({
  story: false,
  auto: false,
  phase: false,
  reveal: false,
  pov: false,
});

/** The smallest side of a control the author has to hit (WCAG 2.5.8). */
const BUTTON_CLASS =
  "inline-flex min-h-6 min-w-6 items-center justify-center gap-1 rounded border border-border px-2 py-1 text-[10px] text-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50";

type SectionProps = {
  node: TreeNodeData;
  workspacePath: string | null;
  /** Changes when A1 or the registry was saved (both expire declarations). */
  refreshKey?: string | number;
};

export function SceneBodyDeclarationSection({
  node,
  workspacePath,
  refreshKey,
}: SectionProps) {
  const { t } = useTranslation();
  const declaration = useSceneBodyDeclaration({
    workspacePath,
    projectId: node.projectId,
    sceneId: node.id,
    version: node.version,
    updatedAt: node.updatedAt,
    title: node.title,
    refreshKey,
  });
  const unsaved = useUnsavedSceneEdits(node.id);
  const { status, view } = declaration;
  if (status === "off" || status === "hidden") return null;

  const codeText = (code: BodyDeclarationRefusalCode | null): string =>
    t(
      `${PREFIX}.code.${code !== null && KNOWN_CODES.has(code) ? code : "unknown-refusal"}`,
    );
  const kind = view?.state.kind ?? null;
  const effective =
    view !== null && view.state.kind === "declared" && view.state.effective;
  const expired =
    view !== null && view.state.kind === "declared" && !view.state.effective;
  const stateKey =
    status === "ready"
      ? kind === "none"
        ? "draft"
        : kind === "unavailable"
          ? "unavailable"
          : effective
            ? "effective"
            : "expired"
      : status === "restart-required"
        ? "restart-required"
        : status === "unknown"
          ? "unknown"
          : "loading";
  const stateLabelKey = {
    draft: "draft",
    unavailable: "unavailable",
    effective: "effective",
    expired: "expired",
    "restart-required": "restartRequired",
    unknown: "unknown",
    loading: "loading",
  }[stateKey];
  const showForm = status === "ready" && (kind === "none" || expired);

  return (
    <section
      data-testid="scene-body-declaration"
      data-state={stateKey}
      aria-label={t(`${PREFIX}.title`)}
      className="flex min-w-0 flex-col gap-1.5 border-t border-border pt-1.5"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
        <ShieldCheck
          size={11}
          aria-hidden
          className="shrink-0 text-muted-foreground"
        />
        <span className="text-[10px] font-semibold text-foreground">
          {t(`${PREFIX}.title`)}
        </span>
        <span
          data-testid="body-declaration-state-label"
          className="ms-auto text-[9px] text-muted-foreground"
        >
          {t(`${PREFIX}.state.${stateLabelKey}`)}
        </span>
      </div>

      <div
        role="status"
        aria-live="polite"
        data-testid="body-declaration-status"
        className="flex min-w-0 flex-col gap-1.5"
      >
        <StateBanner
          stateKey={stateKey}
          view={view}
          failure={declaration.failure}
          becameInvalid={declaration.becameInvalid}
          codeText={codeText}
        />
        <OutcomeNotice
          outcome={declaration.outcome}
          busy={declaration.busy}
          codeText={codeText}
        />
      </div>

      {status === "unknown" && (
        <button
          type="button"
          data-testid="body-declaration-reload"
          onClick={declaration.reload}
          className={`${BUTTON_CLASS} self-start`}
        >
          {t(`${PREFIX}.reload`)}
        </button>
      )}

      {status === "ready" && (
        <>
          <p className="wrap-anywhere text-[10px] text-muted-foreground">
            {t(`${PREFIX}.scopeNote`)}
          </p>
          <p className="wrap-anywhere text-[10px] text-muted-foreground">
            {t(`${PREFIX}.invalidationNote`)}
          </p>
        </>
      )}

      {showForm && (
        <DeclareForm
          key={`${workspacePath ?? ""}\u0000${node.projectId}\u0000${node.id}`}
          sceneId={node.id}
          expired={expired}
          canDeclare={declaration.canDeclare}
          busy={declaration.busy}
          unsaved={unsaved}
          declare={declaration.declare}
        />
      )}

      {status === "ready" && view?.declarationToken != null && (
        <div className="flex min-w-0 flex-col gap-1">
          <button
            type="button"
            data-testid="body-declaration-revoke"
            disabled={!declaration.canRevoke}
            onClick={() => {
              void declaration.revoke();
            }}
            className={`${BUTTON_CLASS} self-start`}
          >
            {declaration.busy === "revoke"
              ? t(`${PREFIX}.revoking`)
              : t(`${PREFIX}.revoke`)}
          </button>
          <span className="wrap-anywhere text-[9px] text-muted-foreground">
            {t(`${PREFIX}.revokeHint`)}
          </span>
        </div>
      )}
    </section>
  );
}

function StateBanner({
  stateKey,
  view,
  failure,
  becameInvalid,
  codeText,
}: {
  stateKey: string;
  view: BodyDeclarationSnapshot | null;
  failure: BodyDeclarationRefusalCode | null;
  becameInvalid: boolean;
  codeText: (code: BodyDeclarationRefusalCode | null) => string;
}) {
  const { t } = useTranslation();
  const frame =
    "flex min-w-0 items-start gap-1.5 rounded border px-2 py-1 text-[10px]";
  if (stateKey === "loading") {
    return (
      <div
        data-testid="body-declaration-banner"
        className={`${frame} border-border text-muted-foreground`}
      >
        <LoaderCircle
          size={11}
          aria-hidden
          className="mt-px shrink-0 motion-safe:animate-spin"
        />
        <span className="min-w-0 wrap-anywhere">{t(`${PREFIX}.loading`)}</span>
      </div>
    );
  }
  if (stateKey === "unknown") {
    return (
      <div
        data-testid="body-declaration-banner"
        className={`${frame} border-border text-muted-foreground`}
      >
        <Info size={11} aria-hidden className="mt-px shrink-0" />
        <span className="min-w-0 wrap-anywhere">
          {t(`${PREFIX}.unknownRead`)} {codeText(failure)}
        </span>
      </div>
    );
  }
  if (stateKey === "restart-required") {
    return (
      <div
        data-testid="body-declaration-banner"
        className={`${frame} border-amber-500/40 bg-amber-500/10 text-amber-950 dark:text-amber-100`}
      >
        <ShieldAlert size={11} aria-hidden className="mt-px shrink-0" />
        <span className="min-w-0 wrap-anywhere">
          {t(`${PREFIX}.restartRequired`)}
        </span>
      </div>
    );
  }
  if (view === null) return null;
  const state = view.state;
  if (state.kind === "unavailable") {
    return (
      <div
        data-testid="body-declaration-banner"
        className={`${frame} border-amber-500/40 bg-amber-500/10 text-amber-950 dark:text-amber-100`}
      >
        <ShieldAlert size={11} aria-hidden className="mt-px shrink-0" />
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="wrap-anywhere font-medium">
            {t(`${PREFIX}.unavailableHeading`)}
          </span>
          <span className="wrap-anywhere">
            {t(`${PREFIX}.unavailable.${state.reason}`)}
          </span>
        </div>
      </div>
    );
  }
  if (state.kind === "declared" && state.effective) {
    return (
      <div
        data-testid="body-declaration-banner"
        className={`${frame} border-emerald-500/40 bg-emerald-500/10 text-emerald-950 dark:text-emerald-100`}
      >
        <ShieldCheck size={11} aria-hidden className="mt-px shrink-0" />
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="wrap-anywhere font-medium">
            {t(`${PREFIX}.effectiveHeading`)}
          </span>
          <span className="wrap-anywhere">{t(`${PREFIX}.effectiveBody`)}</span>
          <span className="wrap-anywhere">
            {t(`${PREFIX}.effectiveExpiresOn`)}
          </span>
        </div>
      </div>
    );
  }
  if (state.kind === "declared") {
    return (
      <div
        data-testid="body-declaration-banner"
        data-became-invalid={becameInvalid ? "true" : undefined}
        className={`${frame} border-amber-500/40 bg-amber-500/10 text-amber-950 dark:text-amber-100`}
      >
        <ShieldAlert size={11} aria-hidden className="mt-px shrink-0" />
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="wrap-anywhere font-medium">
            {t(`${PREFIX}.expiredHeading`)}
          </span>
          {state.blocker !== null && (
            <span
              data-testid="body-declaration-blocker"
              className="wrap-anywhere"
            >
              {t(`${PREFIX}.blockerPrefix`)} {codeText(state.blocker)}
            </span>
          )}
          {state.expiredBy.length > 0 ? (
            <ul className="m-0 flex list-disc flex-col gap-0.5 ps-3.5">
              {state.expiredBy.map((group) => (
                <li
                  key={group}
                  data-testid={`body-declaration-expiry-${group}`}
                  className="wrap-anywhere"
                >
                  {t(`${PREFIX}.expiry.${group}`)}
                </li>
              ))}
            </ul>
          ) : (
            state.blocker === null && (
              <span className="wrap-anywhere">
                {t(`${PREFIX}.expiredUnknown`)}
              </span>
            )
          )}
          <span className="wrap-anywhere">{t(`${PREFIX}.expiredPrompt`)}</span>
        </div>
      </div>
    );
  }
  // A draft: a blocker, when there is one, says why nothing can be declared.
  if (state.blocker === null) return null;
  return (
    <div
      data-testid="body-declaration-banner"
      className={`${frame} border-border text-muted-foreground`}
    >
      <Info size={11} aria-hidden className="mt-px shrink-0" />
      <span
        data-testid="body-declaration-blocker"
        className="min-w-0 wrap-anywhere"
      >
        {t(`${PREFIX}.blockerPrefix`)} {codeText(state.blocker)}
      </span>
    </div>
  );
}

function OutcomeNotice({
  outcome,
  busy,
  codeText,
}: {
  outcome: BodyDeclarationOutcome | null;
  busy: "declare" | "revoke" | null;
  codeText: (code: BodyDeclarationRefusalCode | null) => string;
}) {
  const { t } = useTranslation();
  let text: string | null = null;
  if (busy === "declare") {
    // Only an announcement that Main's own dialog is the next step. This panel
    // never shows an approval of its own.
    text = t(`${PREFIX}.declaring`);
  } else if (busy === "revoke") {
    text = t(`${PREFIX}.revoking`);
  } else if (outcome !== null) {
    switch (outcome.kind) {
      case "declared":
        text = t(`${PREFIX}.outcome.declared`);
        break;
      case "declare-refused":
        text = t(`${PREFIX}.outcome.declareRefused`, {
          reason: codeText(outcome.code),
        });
        break;
      case "revoke-refused":
        text = t(`${PREFIX}.outcome.revokeRefused`, {
          reason: codeText(outcome.code),
        });
        break;
      default:
        text = t(`${PREFIX}.outcome.${outcome.kind}`);
    }
  }
  if (text === null) return null;
  return (
    <p
      data-testid="body-declaration-outcome"
      className="m-0 wrap-anywhere text-[10px] text-foreground"
    >
      {text}
    </p>
  );
}

function DeclareForm({
  sceneId,
  expired,
  canDeclare,
  busy,
  unsaved,
  declare,
}: {
  sceneId: string;
  expired: boolean;
  canDeclare: boolean;
  busy: "declare" | "revoke" | null;
  unsaved: boolean;
  declare: (confirmed: ConfirmedAxes) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  // Nothing is confirmed to begin with and nothing is kept anywhere: the
  // confirmations live only in this form and go away with it.
  const [confirmed, setConfirmed] = useState<ConfirmedAxes>(NOTHING_CONFIRMED);
  const [blockedAtPress, setBlockedAtPress] = useState(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const allConfirmed = BODY_DECLARATION_AXES.every((axis) => confirmed[axis]);
  const disabled = !canDeclare;
  const pressDisabled = disabled || !allConfirmed || unsaved || busy !== null;
  const waitForSave = unsaved || blockedAtPress;

  const toggle = (axis: BodyDeclarationAxis) => {
    if (disabled) return;
    setBlockedAtPress(false);
    setConfirmed((current) => ({ ...current, [axis]: !current[axis] }));
  };
  const press = async () => {
    if (pressDisabled) return;
    // Some drafts (the title) do not announce that they are dirty, so look
    // once more at the moment of the press.
    if (hasUnsavedSceneEdits(sceneId)) {
      setBlockedAtPress(true);
      return;
    }
    setBlockedAtPress(false);
    await declare(confirmed);
    // Whatever came of it, the author confirms again for the next attempt.
    if (mountedRef.current) setConfirmed(NOTHING_CONFIRMED);
  };

  return (
    <div
      data-testid="body-declaration-form"
      className="flex min-w-0 flex-col gap-1.5"
    >
      {!expired && (
        <p className="wrap-anywhere text-[10px] text-muted-foreground">
          {t(`${PREFIX}.draftIntro`)}
        </p>
      )}
      <fieldset
        disabled={disabled}
        className="m-0 flex min-w-0 flex-col gap-0.5 border-0 p-0"
      >
        <legend className="mb-0.5 max-w-full wrap-anywhere p-0 text-[10px] font-medium text-foreground">
          {t(`${PREFIX}.axesLegend`)}
        </legend>
        {BODY_DECLARATION_AXES.map((axis) => (
          <label
            key={axis}
            data-testid={`body-declaration-axis-${axis}`}
            className="grid min-h-6 min-w-0 cursor-pointer grid-cols-[auto_minmax(0,1fr)] gap-x-1.5 rounded px-0.5 py-0.5 text-[10px] has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60"
          >
            <input
              type="checkbox"
              checked={confirmed[axis]}
              disabled={disabled}
              onChange={() => toggle(axis)}
              className="row-span-2 mt-px size-3.5"
            />
            <span className="wrap-anywhere font-medium text-foreground">
              {t(`${PREFIX}.axis.${axis}.label`)}
            </span>
            <span className="wrap-anywhere text-muted-foreground">
              {t(`${PREFIX}.axis.${axis}.help`)}
            </span>
          </label>
        ))}
      </fieldset>
      {!allConfirmed && !disabled && (
        <span className="wrap-anywhere text-[9px] text-muted-foreground">
          {t(`${PREFIX}.axesPending`)}
        </span>
      )}
      {waitForSave && (
        <span
          data-testid="body-declaration-unsaved"
          className="wrap-anywhere text-[10px] text-amber-950 dark:text-amber-100"
        >
          {t(`${PREFIX}.unsavedWait`)}
        </span>
      )}
      <button
        type="button"
        data-testid="body-declaration-declare"
        disabled={pressDisabled}
        onClick={() => {
          void press();
        }}
        className={`${BUTTON_CLASS} self-start`}
      >
        {expired ? t(`${PREFIX}.redeclare`) : t(`${PREFIX}.declare`)}
      </button>
      <span className="wrap-anywhere text-[9px] text-muted-foreground">
        {t(`${PREFIX}.declareHint`)}
      </span>
    </div>
  );
}
