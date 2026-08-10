import { updateNode } from "@/features/tree/api";
import { parseSourceUri } from "./sourceUri";
import { pmJsonToMarkdown } from "./markdownBridge";
import * as mountApi from "./api";
import { useExternalRootStore } from "./externalRootStore";
import { scheduleSceneIndex } from "@/features/semantic-search/scheduler";
import { registerQuiescenceProvider } from "@/lib/quiescenceProviders";

interface WriteBackDraft {
  sourceUri: string;
  pmJson: string;
}

interface ScheduledWriteBack extends WriteBackDraft {
  timer: ReturnType<typeof setTimeout>;
}

const scheduledWrites = new Map<string, ScheduledWriteBack>();
const inFlightWrites = new Map<string, Promise<void>>();
const failedWrites = new Map<
  string,
  { draft: WriteBackDraft; error: unknown }
>();
const DEBOUNCE_MS = 500;
const MAX_STRICT_DRAIN_ROUNDS = 50;

export function scheduleWriteBack(
  sceneId: string,
  sourceUri: string,
  pmJson: string,
): void {
  const existing = scheduledWrites.get(sceneId);
  if (existing) clearTimeout(existing.timer);
  failedWrites.delete(sceneId);
  const timer = setTimeout(() => {
    const scheduled = scheduledWrites.get(sceneId);
    if (!scheduled || scheduled.timer !== timer) return;
    scheduledWrites.delete(sceneId);
    void startWriteBack(sceneId, scheduled);
  }, DEBOUNCE_MS);
  scheduledWrites.set(sceneId, { sourceUri, pmJson, timer });
}

export function hasPendingWriteBack(sceneId: string): boolean {
  return (
    scheduledWrites.has(sceneId) ||
    inFlightWrites.has(sceneId) ||
    failedWrites.has(sceneId)
  );
}

function hasPendingWriteBackForScenes(sceneIds: ReadonlySet<string>): boolean {
  return [...sceneIds].some((sceneId) => hasPendingWriteBack(sceneId));
}

/**
 * Cancel a debounced draft and wait for an already-started native write to
 * settle. A reload-conflict winner can then rewrite the chosen external
 * version without an older local write completing afterwards.
 */
export async function cancelWriteBack(sceneId: string): Promise<void> {
  for (let round = 0; round < MAX_STRICT_DRAIN_ROUNDS; round++) {
    const scheduled = scheduledWrites.get(sceneId);
    if (scheduled) {
      clearTimeout(scheduled.timer);
      scheduledWrites.delete(sceneId);
    }
    failedWrites.delete(sceneId);

    const inFlight = inFlightWrites.get(sceneId);
    if (!inFlight) return;
    await inFlight.catch(() => {});
    // Own the settled slot immediately. The background finally observes that
    // it is no longer current and cannot reinsert a failed stale draft.
    if (inFlightWrites.get(sceneId) === inFlight) {
      inFlightWrites.delete(sceneId);
    }
    failedWrites.delete(sceneId);
  }
  throw new Error("External write-back cancellation did not reach quiescence");
}

async function flushWriteBack(
  sceneId: string,
  sourceUri: string,
  pmJson: string,
): Promise<void> {
  const parsed = parseSourceUri(sourceUri);
  if (!parsed) return;

  const markdown = pmJsonToMarkdown(pmJson);
  useExternalRootStore.getState().mutePath(parsed.rootId, parsed.relPath);
  await mountApi.writeExternalFile(parsed.rootId, parsed.relPath, markdown);
  // persistSceneBody commits this exact snapshot to the DB before scheduling
  // OUT. Rewriting it after the slower disk await lets an old disk write land
  // after a newer editor save and roll the DB back. OUT therefore owns only
  // the external file plus sync metadata/index publication.
  await updateNode(sceneId, { sourceMtime: new Date().toISOString() });
  scheduleSceneIndex(sceneId);
}

function startWriteBack(sceneId: string, draft: WriteBackDraft): Promise<void> {
  const previous = inFlightWrites.get(sceneId);
  const write = (previous ? previous.catch(() => {}) : Promise.resolve()).then(
    () => flushWriteBack(sceneId, draft.sourceUri, draft.pmJson),
  );
  inFlightWrites.set(sceneId, write);
  void write
    .then(() => {
      if (inFlightWrites.get(sceneId) === write) failedWrites.delete(sceneId);
    })
    .catch((error: unknown) => {
      if (inFlightWrites.get(sceneId) === write) {
        failedWrites.set(sceneId, { draft, error });
      }
    })
    .finally(() => {
      if (inFlightWrites.get(sceneId) === write) {
        inFlightWrites.delete(sceneId);
      }
    });
  return write;
}

/**
 * Flush every debounced/in-flight external-file write before a destructive
 * lifecycle boundary. Failed drafts remain available for an explicit retry.
 */
export async function flushAllWriteBacksStrict(): Promise<void> {
  // A failure recorded by background debounce gets one explicit lifecycle
  // retry. A failure produced by this strict attempt is reported immediately;
  // retrying it again inside the same call could turn a transient-looking
  // second outcome into a false success.
  const retryableAtStart = [...failedWrites.entries()];
  failedWrites.clear();

  for (let round = 0; round < MAX_STRICT_DRAIN_ROUNDS; round++) {
    for (const [sceneId, scheduled] of [...scheduledWrites]) {
      clearTimeout(scheduled.timer);
      scheduledWrites.delete(sceneId);
      // The newly scheduled draft is authoritative for this scene. An older
      // in-flight failure may have landed after scheduleWriteBack cleared it.
      failedWrites.delete(sceneId);
      startWriteBack(sceneId, scheduled);
    }
    if (round === 0) {
      for (const [sceneId, failed] of retryableAtStart) {
        // A newer scheduled/in-flight draft supersedes this failed snapshot.
        if (!inFlightWrites.has(sceneId) && !scheduledWrites.has(sceneId)) {
          startWriteBack(sceneId, failed.draft);
        }
      }
    }

    if (inFlightWrites.size > 0) {
      await Promise.allSettled([...new Set(inFlightWrites.values())]);
    }

    // A write can be scheduled while an earlier native write is awaiting.
    // Re-snapshot instead of allowing Project/Workspace/window destruction to
    // proceed with that new debounce still armed against the old workspace.
    if (scheduledWrites.size > 0 || inFlightWrites.size > 0) continue;
    if (failedWrites.size > 0) {
      throw new AggregateError(
        [...failedWrites.values()].map(({ error }) => error),
        "One or more external write-backs failed",
      );
    }
    return;
  }

  throw new Error("External write-backs did not reach quiescence");
}

/**
 * Flush only the external-file drafts owned by a narrative corpus. Other
 * mounted Scenes remain debounced and cannot block an unrelated snapshot.
 */
export async function flushWriteBacksForScenes(
  sceneIds: readonly string[],
): Promise<void> {
  const targets = new Set(sceneIds);
  if (targets.size === 0) return;

  const retryableAtStart = [...failedWrites.entries()].filter(([sceneId]) =>
    targets.has(sceneId),
  );
  for (const [sceneId] of retryableAtStart) failedWrites.delete(sceneId);

  for (let round = 0; round < MAX_STRICT_DRAIN_ROUNDS; round++) {
    for (const [sceneId, scheduled] of [...scheduledWrites]) {
      if (!targets.has(sceneId)) continue;
      clearTimeout(scheduled.timer);
      scheduledWrites.delete(sceneId);
      failedWrites.delete(sceneId);
      startWriteBack(sceneId, scheduled);
    }
    if (round === 0) {
      for (const [sceneId, failed] of retryableAtStart) {
        if (!inFlightWrites.has(sceneId) && !scheduledWrites.has(sceneId)) {
          startWriteBack(sceneId, failed.draft);
        }
      }
    }

    const targetWrites = [...inFlightWrites.entries()]
      .filter(([sceneId]) => targets.has(sceneId))
      .map(([, write]) => write);
    if (targetWrites.length > 0) {
      await Promise.allSettled([...new Set(targetWrites)]);
    }

    if (hasPendingWriteBackForScenes(targets)) {
      const failures = [...failedWrites.entries()].filter(([sceneId]) =>
        targets.has(sceneId),
      );
      const hasActiveTarget = [...targets].some(
        (sceneId) =>
          scheduledWrites.has(sceneId) || inFlightWrites.has(sceneId),
      );
      if (!hasActiveTarget && failures.length > 0) {
        throw new AggregateError(
          failures.map(([, { error }]) => error),
          "One or more scoped external write-backs failed",
        );
      }
      continue;
    }
    return;
  }

  throw new Error("Scoped external write-backs did not reach quiescence");
}

registerQuiescenceProvider({
  id: "external-file-write-back",
  stage: "external-write-back",
  flush: flushAllWriteBacksStrict,
  recovery: () =>
    [...failedWrites.entries()].map(([sceneId, { draft }]) => ({
      kind: "external-write-back",
      id: sceneId,
      sourceUri: draft.sourceUri,
      prosemirror: draft.pmJson,
    })),
});

/** Test helper */
export function _resetWriteBackTimers(): void {
  for (const scheduled of scheduledWrites.values()) {
    clearTimeout(scheduled.timer);
  }
  scheduledWrites.clear();
  inFlightWrites.clear();
  failedWrites.clear();
}
