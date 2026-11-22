import {
  acquireTimelapseReplacementFence,
  openOwnSaveCapture,
  type TimelapseCoverageProof,
  type TimelapseDocumentIdentity,
  type TimelapseDocumentRef,
  type TimelapseOwnSaveCapture,
} from "./documentCoverage";
import { runAfterTimelapseGenesis } from "./genesisBarrier";
import { flushStrict } from "./recorder";

export type { TimelapseDocumentIdentity } from "./documentCoverage";

export interface TimelapseBodyWriteInput {
  projectId: string;
  /** Accepted doc.step capability, when this body is covered by queued steps. */
  coverageReceipt?: TimelapseDocumentRef;
  /** Canonical document identity used to scope the replacement fence. */
  documentIdentity: TimelapseDocumentIdentity;
  /** Exact body string sent to Native and covered by the returned digest. */
  content: string;
  preexistingDraft?: boolean;
}

export interface TimelapseBodyWriteCallbacks<TCommit, TResult> {
  /** Ends at the authoritative Native body commit, before renderer projection. */
  commit(coverage: TimelapseCoverageProof | undefined): Promise<TCommit>;
  /** Defaults to true; false cancels coverage when no body row was committed. */
  didCommit?(committed: TCommit): boolean;
  /** Runs after coverage/snapshot ownership has committed. */
  project(committed: TCommit): Promise<TResult>;
}

/**
 * Persist one editor-backed full body without racing its doc.step stream.
 *
 * Renderer-supplied coverage is currently fail-closed. The capability is
 * retained in the input for source compatibility, but until Native can mint
 * and validate the proof itself this path always takes a structural replacement
 * fence and asks Native to append the authoritative full-body snapshot.
 * Admission is synchronous; the rest of the interval is queued on a
 * project-global body tail so two documents cannot cross their snapshot
 * boundaries.
 */
export function runTimelapseBodyWrite<TCommit, TResult>(
  input: TimelapseBodyWriteInput,
  callbacks: TimelapseBodyWriteCallbacks<TCommit, TResult>,
): Promise<TResult> {
  // `coverageReceipt` is deliberately not consumed here. Merely possessing a
  // renderer capability must not authorize suppression of a Native snapshot.
  void input.coverageReceipt;
  const fence = acquireTimelapseReplacementFence({
    projectId: input.projectId,
    document: input.documentIdentity,
  });
  let fenceReleased = false;
  const releaseFence = (): void => {
    if (fenceReleased) return;
    fenceReleased = true;
    fence.release();
  };

  const task = enqueueProjectBodyWrite(input.projectId, () =>
    runAfterTimelapseGenesis(
      input.projectId,
      async () => {
        await flushStrict();
        const committed = await callbacks.commit(undefined);
        const didCommit = callbacks.didCommit?.(committed) ?? true;
        if (didCommit) fence.commit();
        const projected = await callbacks.project(committed);
        releaseFence();
        return projected;
      },
      input.preexistingDraft ? { preexistingDraft: true } : undefined,
    ),
  );

  return task.finally(() => {
    releaseFence();
  });
}

export interface TimelapseBodyReplacementInput {
  projectId: string;
  documentIdentity?: TimelapseDocumentIdentity;
  preexistingDraft?: boolean;
}

/**
 * Run an authoritative full-body replacement under a synchronous admission
 * fence. Native owns the atomic snapshot; the fence remains closed through
 * renderer projection so an editor cannot transact against the old body.
 */
export function runTimelapseBodyReplacement<TCommit, TResult>(
  input: TimelapseBodyReplacementInput,
  callbacks: Omit<TimelapseBodyWriteCallbacks<TCommit, TResult>, "commit"> & {
    commit(): Promise<TCommit>;
  },
): Promise<TResult> {
  const fence = acquireTimelapseReplacementFence({
    projectId: input.projectId,
    ...(input.documentIdentity ? { document: input.documentIdentity } : {}),
  });
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    fence.release();
  };

  const task = enqueueProjectBodyWrite(input.projectId, () =>
    runAfterTimelapseGenesis(
      input.projectId,
      async () => {
        await flushStrict();
        const committed = await callbacks.commit();
        if (callbacks.didCommit?.(committed) ?? true) fence.commit();
        const projected = await callbacks.project(committed);
        release();
        return projected;
      },
      input.preexistingDraft ? { preexistingDraft: true } : undefined,
    ),
  );

  return task.finally(release);
}

export interface TimelapseEditorBodyWriteInput {
  projectId: string;
  /** 正準の文書 identity。hold の key になる。 */
  documentIdentity: TimelapseDocumentIdentity;
  preexistingDraft?: boolean;
  /**
   * 呼び手が content の捕捉と同じ同期区間で開いた hold（codex／snippet、EAR-12）。
   * 引き取った後の release はこの関数が行う。ここに届かなかった経路の release は
   * 呼び手の（冪等な）release が受け持つ。
   */
  capture?: TimelapseOwnSaveCapture;
}

/**
 * editor が自分の autosave で本文全体を保存する（EAR-1）。
 *
 * 上の 2 関数と違い replacement fence も文書 lease も取らず、editor は
 * writable のまま。窓内に打たれた doc.step は recorder の capture hold に預かり、
 * Native の snapshot が commit された後に元の順で放流する。これで anchor 以前の
 * step はすべて snapshot に含まれ、以後の step は snapshot を土台にする。
 * 外部の置換（agent 書込み、undo、復元、import）は従来の fence の関数を使うこと。
 *
 * hold は最初の await の前に同期で開く。release の owner は 2 つで、どちらも冪等：
 * 操作が呼ばれた場合は内側の `finally`。次の body 書込みの `flushStrict` が前の
 * 窓の放流分を必ず見るよう project tail の内側で行い、renderer の projection の
 * 前に済ませる。操作が呼ばれなかった場合（`runAfterTimelapseGenesis` が authority
 * の stale や genesis の失敗・abort で操作を呼ばずに reject する）は外側の
 * `task.finally`。
 */
export function runTimelapseEditorBodyWrite<TCommit, TResult>(
  input: TimelapseEditorBodyWriteInput,
  callbacks: Omit<TimelapseBodyWriteCallbacks<TCommit, TResult>, "commit"> & {
    commit(): Promise<TCommit>;
  },
): Promise<TResult> {
  const capture =
    input.capture ??
    openOwnSaveCapture({
      projectId: input.projectId,
      document: input.documentIdentity,
    });

  const task = enqueueProjectBodyWrite(input.projectId, () =>
    runAfterTimelapseGenesis(
      input.projectId,
      async () => {
        let committed: TCommit;
        try {
          await flushStrict();
          committed = await callbacks.commit();
          if (callbacks.didCommit?.(committed) ?? true) capture.commit();
        } finally {
          capture.release();
        }
        return callbacks.project(committed);
      },
      input.preexistingDraft ? { preexistingDraft: true } : undefined,
    ),
  );

  return task.finally(() => {
    capture.release();
  });
}

/**
 * Generic non-body mutations still need the same genesis authority interval,
 * but do not participate in body coverage ordering. Keep this small adapter in
 * the body module so production callers never reach for the low-level await
 * helper directly.
 */
export function runTimelapseMutation<T>(
  projectId: string,
  operation: () => Promise<T>,
  options?: { preexistingDraft?: boolean },
): Promise<T> {
  return runAfterTimelapseGenesis(projectId, operation, options);
}

const projectBodyTails = new Map<string, Promise<unknown>>();

function enqueueProjectBodyWrite<T>(
  projectId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = projectBodyTails.get(projectId);
  const task = (
    previous ? previous.catch(() => undefined) : Promise.resolve()
  ).then(operation);
  projectBodyTails.set(projectId, task);

  // Attach both rejection and fulfillment handlers to the cleanup promise. A
  // failed body write must be observed by its caller without producing a
  // second unhandled rejection from the tail bookkeeping itself.
  void task.then(
    () => {
      if (projectBodyTails.get(projectId) === task) {
        projectBodyTails.delete(projectId);
      }
    },
    () => {
      if (projectBodyTails.get(projectId) === task) {
        projectBodyTails.delete(projectId);
      }
    },
  );
  return task;
}

/** @internal */
export function _resetTimelapseBodyWriteTailsForTests(): void {
  projectBodyTails.clear();
}
