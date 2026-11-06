/**
 * Main-process guard for unsaved edits at a fatal shutdown (PUB-G required
 * precondition #36, DR-PUBG-36-1 in
 * `docs/plans/nir1-lane-decisions/cp3b-decisions.md`).
 *
 * The unsaved text lives only in the renderer (AutoSave closures); Main has
 * no queue of its own and writes nothing. Each window reports one boolean
 * whenever it changes. When the quit finalizer is about to call `exit(1)`
 * because Native shutdown could not be proven, Main reads those flags and, if
 * a live window still holds unsaved edits, asks the author whether to exit
 * anyway or go back and copy the text out by hand.
 *
 * Reachability: a window that already closed went through the renderer's
 * close-quiescence dialog (retry / export / discard), so only a window that is
 * still alive at `will-quit` can be asked here. A destroyed owner is never
 * asked and its flag is dropped.
 */
import {
  REPORT_UNSAVED_EDITS_COMMAND,
  UNSAVED_EDITS_RETAINED_EVENT,
  parseUnsavedEditsReport,
} from "../shared/unsavedEditsWire.js";
import type { ShellCommandHandlers } from "../shared/ipcContract.js";

export type FatalExitDecision = "exit" | "stay";

export interface UnsavedEditsGuardDeps {
  /** True while the window's renderer can still be told something. */
  isOwnerAlive(ownerId: number): boolean;
  /** The confirmation shown to the author. Must not throw on normal use. */
  confirm(): Promise<FatalExitDecision>;
  /** Tell one window to show its sticky "copy your text out" notice. */
  notifyRetained(ownerId: number, channel: string, payload: unknown): void;
}

export interface UnsavedEditsGuard {
  /** `report_unsaved_edits` for one window (the extra-shell-handler seam). */
  handlersForOwner(ownerId: number): ShellCommandHandlers;
  /** Drop a window's flag (window gone). */
  forget(ownerId: number): void;
  /** Live windows currently reporting unsaved edits. */
  ownersWithUnsaved(): number[];
  /**
   * Called by the quit finalizer right before a fatal `exit(1)`. Resolves
   * `exit` when nothing is unsaved (the previous behaviour) or the author
   * chose to exit; `stay` when the author went back.
   */
  confirmBeforeFatalExit(): Promise<FatalExitDecision>;
}

export function createUnsavedEditsGuard(
  deps: UnsavedEditsGuardDeps,
): UnsavedEditsGuard {
  const flags = new Map<number, boolean>();

  const ownersWithUnsaved = (): number[] => {
    const owners: number[] = [];
    for (const [ownerId, hasUnsaved] of [...flags]) {
      if (!deps.isOwnerAlive(ownerId)) {
        flags.delete(ownerId);
        continue;
      }
      if (hasUnsaved) owners.push(ownerId);
    }
    return owners;
  };

  return {
    handlersForOwner(ownerId) {
      return {
        [REPORT_UNSAVED_EDITS_COMMAND]: async (args) => {
          const report = parseUnsavedEditsReport(args);
          if (report === null) {
            throw new Error(
              `IPC_INVALID_REQUEST: invalid args for command \`${REPORT_UNSAVED_EDITS_COMMAND}\`: expected { hasUnsaved: boolean }`,
            );
          }
          if (report.hasUnsaved) flags.set(ownerId, true);
          else flags.delete(ownerId);
          return null;
        },
      };
    },
    forget(ownerId) {
      flags.delete(ownerId);
    },
    ownersWithUnsaved,
    async confirmBeforeFatalExit() {
      const owners = ownersWithUnsaved();
      if (owners.length === 0) return "exit";
      let decision: FatalExitDecision;
      try {
        decision = await deps.confirm();
      } catch {
        // A broken dialog must not turn a fatal exit into a hang.
        return "exit";
      }
      if (decision === "stay") {
        for (const ownerId of owners) {
          // Only a live window is told; a failed send cannot undo the choice.
          try {
            if (deps.isOwnerAlive(ownerId)) {
              deps.notifyRetained(ownerId, UNSAVED_EDITS_RETAINED_EVENT, {
                kind: "unsaved-edits-retained",
              });
            }
          } catch {
            // The dialog already told the author what to do.
          }
        }
      }
      return decision;
    },
  };
}

/**
 * The confirmation. Both languages are shown because Main has no UI language
 * of its own. The safe choice (go back) is the default and the Escape result.
 */
export async function showUnsavedFatalExitDialog(dialog: {
  showMessageBox(options: {
    type: "warning";
    title: string;
    message: string;
    detail: string;
    buttons: string[];
    defaultId: number;
    cancelId: number;
    noLink: boolean;
  }): Promise<{ response: number }>;
}): Promise<FatalExitDecision> {
  const { response } = await dialog.showMessageBox({
    type: "warning",
    title: "Grimodex",
    message: "未保存の編集があります / There are unsaved edits",
    detail: [
      "安全に終了できないため、このまま終了すると未保存の編集は失われます。戻って、編集中の文章をコピーして控えてください。",
      "The app could not shut down safely. Exiting now will lose your unsaved edits. Go back and copy the text you are editing to keep it.",
    ].join("\n\n"),
    buttons: [
      "戻って内容を控える / Go back and copy my text",
      "このまま終了する(未保存の編集は失われる) / Exit anyway (unsaved edits are lost)",
    ],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  return response === 1 ? "exit" : "stay";
}
