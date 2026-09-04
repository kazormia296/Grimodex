import {
  acquireTimelapseReplacementFence,
  type TimelapseCoverageProof,
  type TimelapseDocumentIdentity,
  type TimelapseDocumentRef,
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
