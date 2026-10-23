/**
 * State of one Scene's body declaration for the author's screen (CB-3).
 *
 * The hook owns no truth: `effective` is Native's judgement. It only keeps the
 * latest snapshot, runs the three operations (read, declare, revoke) one at a
 * time, and drops every answer that belongs to an earlier Scene, workspace or
 * unmounted screen (identity plus epoch, the way `SceneScopeEditor` does).
 *
 * While the product UI constant is off, or when there is no workspace, it does
 * nothing and invokes nothing. It never stores anything (no storage, no log, no
 * undo entry), and a snapshot that is loading, unknown or failed is never shown
 * as effective: `view` is only set while the status is `ready`.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { isBodyDeclarationUiEnabled } from "./bodyDeclarationAvailability";
import {
  declareBody,
  readBodyDeclarationState,
  revokeBody,
} from "./bodyDeclarationApi";
import {
  BODY_DECLARATION_AXES,
  type BodyDeclarationRefusalCode,
  type BodyDeclarationRevokeOutcome,
  type BodyDeclarationScene,
  type BodyDeclarationSnapshot,
  type ConfirmedAxes,
} from "./bodyDeclarationTypes";

export type BodyDeclarationStatus =
  /** The UI constant is off, or there is no workspace. Nothing is invoked. */
  | "off"
  /** A read is in flight. Nothing is known yet. */
  | "loading"
  /** `view` is the answer of the latest completed read. */
  | "ready"
  /** The read failed. Nothing is known; never shown as effective. */
  | "unknown"
  /** Native is quarantined until restart: declare and revoke are refused. */
  | "restart-required"
  /** Closed gate, another workspace or a refused caller: render nothing. */
  | "hidden";

/** What the author's last operation ended with. */
export type BodyDeclarationOutcome =
  | { readonly kind: "declared" }
  | {
      readonly kind: "declare-refused";
      readonly code: BodyDeclarationRefusalCode;
    }
  | { readonly kind: BodyDeclarationRevokeOutcome }
  | {
      readonly kind: "revoke-refused";
      readonly code: BodyDeclarationRefusalCode;
    };

export type UseSceneBodyDeclarationInput = {
  readonly workspacePath: string | null;
  readonly projectId: string;
  readonly sceneId: string;
  /**
   * A change of the Scene row (body, title) expires a declaration, so these
   * trigger one re-read. They are only compared, never sent or rendered.
   */
  readonly version?: number;
  readonly updatedAt?: string;
  readonly title?: string;
  /** Bumped when A1 or the registry was saved (both expire declarations). */
  readonly refreshKey?: string | number;
};

export type UseSceneBodyDeclarationResult = {
  readonly status: BodyDeclarationStatus;
  /** The latest answer, only while the status is `ready`. */
  readonly view: BodyDeclarationSnapshot | null;
  /** The code of the failed read, while the status is `unknown`. */
  readonly failure: BodyDeclarationRefusalCode | null;
  /** The operation in flight (a read is the `loading` status). */
  readonly busy: "declare" | "revoke" | null;
  readonly outcome: BodyDeclarationOutcome | null;
  /**
   * True when the latest read showed that a declaration which had been
   * effective no longer is: it expired, it is paused, it is gone (revoked in
   * another window, cleared by a restore) or it cannot be read. The author may
   * not have noticed it happen. An author's own revoke does not count.
   */
  readonly becameInvalid: boolean;
  readonly canDeclare: boolean;
  readonly canRevoke: boolean;
  /** Asks Native to declare; false when nothing was started. */
  readonly declare: (confirmed: ConfirmedAxes) => Promise<boolean>;
  /** Revokes the declaration the screen read; false when nothing was started. */
  readonly revoke: () => Promise<boolean>;
  /** Reads again (a manual reload). */
  readonly reload: () => void;
};

type HookState = {
  /** The Scene this state belongs to; another key means it is stale. */
  readonly key: string | null;
  readonly status: BodyDeclarationStatus;
  readonly view: BodyDeclarationSnapshot | null;
  readonly failure: BodyDeclarationRefusalCode | null;
  readonly busy: "declare" | "revoke" | null;
  readonly outcome: BodyDeclarationOutcome | null;
  readonly becameInvalid: boolean;
};

const HIDING_CODES: ReadonlySet<BodyDeclarationRefusalCode> = new Set([
  "gate-closed",
  "workspace-mismatch",
  "egress-denied",
]);

function emptyState(
  key: string | null,
  status: BodyDeclarationStatus,
): HookState {
  return {
    key,
    status,
    view: null,
    failure: null,
    busy: null,
    outcome: null,
    becameInvalid: false,
  };
}

type Target = {
  readonly key: string | null;
  readonly scene: BodyDeclarationScene | null;
};

function isEffective(snapshot: BodyDeclarationSnapshot | null): boolean {
  return (
    snapshot !== null &&
    snapshot.state.kind === "declared" &&
    snapshot.state.effective
  );
}

export function useSceneBodyDeclaration(
  input: UseSceneBodyDeclarationInput,
): UseSceneBodyDeclarationResult {
  const { workspacePath, projectId, sceneId } = input;
  const active =
    isBodyDeclarationUiEnabled() &&
    workspacePath !== null &&
    workspacePath !== "";
  const key = active
    ? JSON.stringify([workspacePath, projectId, sceneId])
    : null;
  const triggerSignature = JSON.stringify([
    input.version ?? null,
    input.updatedAt ?? null,
    input.title ?? null,
    input.refreshKey ?? null,
  ]);

  const [state, setState] = useState<HookState>(() =>
    emptyState(key, active ? "loading" : "off"),
  );

  // The latest identity, assigned while rendering so a late answer is judged
  // against it before React runs any effect cleanup.
  const targetRef = useRef<Target>({ key: null, scene: null });
  targetRef.current = {
    key,
    scene: active
      ? { workspacePath: workspacePath as string, projectId, sceneId }
      : null,
  };
  const signatureRef = useRef(triggerSignature);
  signatureRef.current = triggerSignature;

  const epochRef = useRef(0);
  const inFlightRef = useRef<"read" | "declare" | "revoke" | null>(null);
  const pendingRef = useRef(false);
  const stickyRef = useRef<"hidden" | "restart-required" | null>(null);
  const readyRef = useRef<BodyDeclarationSnapshot | null>(null);
  const handledSignatureRef = useRef(triggerSignature);
  const lastEffectiveRef = useRef(false);

  const startRead = useCallback(function run(
    manual: boolean,
    keepOutcome = false,
  ): void {
    const target = targetRef.current;
    if (target.scene === null) return;
    // Never two operations at once. Triggers that arrive meanwhile become one
    // re-read after the operation ends.
    if (inFlightRef.current !== null) {
      pendingRef.current = true;
      return;
    }
    if (stickyRef.current === "hidden") return;
    if (stickyRef.current === "restart-required" && !manual) return;
    const epoch = epochRef.current;
    inFlightRef.current = "read";
    readyRef.current = null;
    setState((current) => ({
      ...emptyState(target.key, "loading"),
      busy: null,
      // The outcome of the author's own operation stays until the state is
      // read again for any other reason; then it would sit beside a newer
      // banner it no longer describes.
      outcome:
        keepOutcome && current.key === target.key ? current.outcome : null,
    }));
    void readBodyDeclarationState(target.scene).then((result) => {
      if (epoch !== epochRef.current) return;
      inFlightRef.current = null;
      if (!result.ok) {
        readyRef.current = null;
        const code = result.code;
        if (HIDING_CODES.has(code)) {
          stickyRef.current = "hidden";
          setState((current) => ({
            ...current,
            status: "hidden",
            view: null,
            failure: null,
            busy: null,
            becameInvalid: false,
          }));
        } else if (code === "restart-required") {
          stickyRef.current = "restart-required";
          setState((current) => ({
            ...current,
            status: "restart-required",
            view: null,
            failure: code,
            busy: null,
            becameInvalid: false,
          }));
        } else {
          setState((current) => ({
            ...current,
            status: "unknown",
            view: null,
            failure: code,
            busy: null,
            becameInvalid: false,
          }));
        }
      } else if (result.snapshot.state.blocker === "scene-not-found") {
        // The Scene is gone (deleted elsewhere): there is nothing to declare or
        // revoke, so nothing is shown. Not sticky: another Scene, or a Scene
        // that is back, reads again.
        lastEffectiveRef.current = false;
        readyRef.current = null;
        setState((current) => ({
          ...current,
          status: "hidden",
          view: null,
          failure: null,
          busy: null,
          becameInvalid: false,
        }));
      } else {
        stickyRef.current = null;
        const snapshot = result.snapshot;
        const becameInvalid =
          lastEffectiveRef.current && !isEffective(snapshot);
        lastEffectiveRef.current = isEffective(snapshot);
        readyRef.current = snapshot;
        setState((current) => ({
          ...current,
          status: "ready",
          view: snapshot,
          failure: null,
          busy: null,
          becameInvalid,
        }));
      }
      if (pendingRef.current) {
        pendingRef.current = false;
        run(false);
      }
    });
  }, []);

  // A new Scene or workspace: everything of the previous one is dropped, and
  // answers still in flight for it are ignored.
  useEffect(() => {
    epochRef.current += 1;
    inFlightRef.current = null;
    pendingRef.current = false;
    stickyRef.current = null;
    readyRef.current = null;
    lastEffectiveRef.current = false;
    handledSignatureRef.current = signatureRef.current;
    if (targetRef.current.scene === null) {
      setState(emptyState(targetRef.current.key, "off"));
    } else {
      startRead(true);
    }
    return () => {
      epochRef.current += 1;
      inFlightRef.current = null;
      pendingRef.current = false;
    };
  }, [key, startRead]);

  // A change of the Scene row or a saved A1/registry expires declarations:
  // read again (once, however many arrive while a read is running).
  useEffect(() => {
    if (handledSignatureRef.current === triggerSignature) return;
    handledSignatureRef.current = triggerSignature;
    startRead(false);
  }, [triggerSignature, startRead]);

  // Coming back to the window: the Scene may have been changed elsewhere.
  useEffect(() => {
    if (!active) return;
    const onFocus = () => startRead(false);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [active, startRead]);

  const runOperation = useCallback(
    async (
      kind: "declare" | "revoke",
      perform: (scene: BodyDeclarationScene) => Promise<BodyDeclarationOutcome>,
    ): Promise<boolean> => {
      const target = targetRef.current;
      if (target.scene === null) return false;
      if (inFlightRef.current !== null || stickyRef.current !== null) {
        return false;
      }
      const epoch = epochRef.current;
      inFlightRef.current = kind;
      setState((current) =>
        current.key === target.key
          ? { ...current, busy: kind, outcome: null }
          : current,
      );
      let outcome: BodyDeclarationOutcome;
      try {
        outcome = await perform(target.scene);
      } catch {
        outcome =
          kind === "declare"
            ? { kind: "declare-refused", code: "unknown-refusal" }
            : { kind: "revoke-refused", code: "unknown-refusal" };
      }
      if (epoch !== epochRef.current) return true;
      inFlightRef.current = null;
      // The re-read below covers every trigger that came in meanwhile.
      pendingRef.current = false;
      // What the author just did is not news to the author: a revoke that
      // ends an effective declaration is reported by its own outcome, not as a
      // declaration that "became invalid".
      lastEffectiveRef.current = false;
      setState((current) =>
        current.key === target.key
          ? { ...current, busy: null, outcome }
          : current,
      );
      // Whatever happened, the next thing shown is what Native says now.
      startRead(true, true);
      return true;
    },
    [startRead],
  );

  const declare = useCallback(
    (confirmed: ConfirmedAxes): Promise<boolean> => {
      const snapshot = readyRef.current;
      if (
        snapshot === null ||
        snapshot.occ === null ||
        snapshot.state.blocker !== null ||
        snapshot.state.kind === "unavailable" ||
        !BODY_DECLARATION_AXES.every((axis) => confirmed[axis] === true)
      ) {
        return Promise.resolve(false);
      }
      const { occ, declarationToken } = snapshot;
      return runOperation("declare", async (scene) => {
        const result = await declareBody({
          scene,
          occ,
          declarationToken,
          confirmed,
        });
        return result.ok
          ? { kind: "declared" }
          : { kind: "declare-refused", code: result.code };
      });
    },
    [runOperation],
  );

  const revoke = useCallback((): Promise<boolean> => {
    const snapshot = readyRef.current;
    if (snapshot === null || snapshot.declarationToken === null) {
      return Promise.resolve(false);
    }
    const token = snapshot.declarationToken;
    return runOperation("revoke", async (scene) => {
      const result = await revokeBody({ scene, declarationToken: token });
      return result.ok
        ? { kind: result.outcome }
        : { kind: "revoke-refused", code: result.code };
    });
  }, [runOperation]);

  const reload = useCallback(() => startRead(true), [startRead]);

  // A state that belongs to another Scene is not shown, not even for the one
  // render before the effect resets it.
  const current =
    state.key === key ? state : emptyState(key, active ? "loading" : "off");
  const ready = current.status === "ready" && current.view !== null;
  const view = ready ? current.view : null;
  const canAct = ready && current.busy === null;
  return {
    status: current.status,
    view,
    failure: current.failure,
    busy: current.busy,
    outcome: current.outcome,
    becameInvalid: current.becameInvalid,
    canDeclare:
      canAct &&
      view !== null &&
      view.occ !== null &&
      view.state.blocker === null &&
      view.state.kind !== "unavailable",
    canRevoke: canAct && view !== null && view.declarationToken !== null,
    declare,
    revoke,
    reload,
  };
}
