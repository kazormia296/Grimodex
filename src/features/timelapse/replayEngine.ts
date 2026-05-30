/**
 * 執筆タイムラプス replay engine — Editor 系 step 再生（P2 + P7 cursor）。
 *
 * Given an initial ProseMirror doc and a sequence of step JSONs captured by
 * the recorder, applies them in order. Two surfaces:
 *  - `replayEditorSteps`  — one-shot: apply everything, return the final doc.
 *  - `createReplayCursor` — incremental: advance the doc step-by-step so the
 *    video frame producer can emit N frames without O(N^2) re-replay.
 *
 * Codex / Snippet / Grid / Map domains will plug in here in later phases
 * (P3+). For now the engine deliberately only knows about `editor` /
 * `codex` / `snippet` body steps — other domains are no-ops.
 */

import { Node as ProseMirrorNode, Schema } from "@tiptap/pm/model";
import { Step } from "@tiptap/pm/transform";
import type { ChangeEvent } from "@/db/schema";

export interface EditorReplayResult {
  doc: ProseMirrorNode;
  /** How many steps from `events` were successfully applied. */
  appliedSteps: number;
  /** First sequence number that could not be applied (if any). */
  failedAt?: number;
  /** Human-readable failure reason (if any). */
  reason?: string;
}

export interface ReplayFailure {
  failedAt: number;
  reason: string;
}

/** Minimal event shape the engine consumes. */
export type ReplayEvent = Pick<
  ChangeEvent,
  "domain" | "opType" | "payload" | "sequence"
>;

/**
 * Incremental replay cursor over a coherent (single-entity, sequence-ascending)
 * slice of editor body events. Maintains a running doc so advancing by a delta
 * is O(delta) — the frame producer reuses one cursor across all frames instead
 * of re-replaying from scratch each frame.
 *
 * On the first unrecoverable event the cursor records `failure` and stops
 * advancing; subsequent `applyUntil` / `applyNext` calls are no-ops. This
 * mirrors the early-return contract of the one-shot `replayEditorSteps`.
 */
export interface ReplayCursor {
  /** Current reconstructed document. */
  readonly doc: ProseMirrorNode;
  /** How many individual steps have been applied so far. */
  readonly appliedSteps: number;
  /** Sequence of the most recently processed event (null before first advance). */
  readonly atSequence: number | null;
  /** Set once an event fails to apply; halts further advancement. */
  readonly failure: ReplayFailure | null;
  /**
   * Advance through every event with `sequence <= targetSequence`, applying
   * its steps. Assumes events are sorted ascending by sequence.
   */
  applyUntil(targetSequence: number): void;
  /**
   * Advance exactly one event (applying its steps, or skipping a non-body /
   * non-`doc.step` event). Returns true if it advanced without failure, false
   * if the stream is exhausted or a failure occurred.
   */
  applyNext(): boolean;
}

export function createReplayCursor(
  schema: Schema,
  initialDoc: ProseMirrorNode,
  events: readonly ReplayEvent[],
): ReplayCursor {
  let doc = initialDoc;
  let applied = 0;
  let index = 0;
  let atSequence: number | null = null;
  let failure: ReplayFailure | null = null;

  // Apply one event's steps onto `doc`. Returns false (and sets `failure`) on
  // the first unrecoverable error; steps that succeeded before it stay applied.
  function processEvent(ev: ReplayEvent): boolean {
    if (ev.opType !== "doc.step") return true;
    if (!isEditorBodyDomain(ev.domain)) return true;
    let payload: { steps?: unknown };
    try {
      payload = JSON.parse(ev.payload);
    } catch (e) {
      failure = {
        failedAt: ev.sequence,
        reason: `payload not JSON: ${(e as Error).message}`,
      };
      return false;
    }
    if (!Array.isArray(payload.steps)) return true;
    for (const rawStep of payload.steps) {
      let step: Step;
      try {
        step = Step.fromJSON(schema, rawStep as never);
      } catch (e) {
        failure = {
          failedAt: ev.sequence,
          reason: `Step.fromJSON failed: ${(e as Error).message}`,
        };
        return false;
      }
      // step.apply normally signals failure via result.failed, but it can
      // also *throw* — ProseMirror's ReplaceStep resolves the step's positions
      // against `doc`, and resolve() throws RangeError("Position N out of
      // range") when a recorded position exceeds the reconstructed doc (an
      // un-seedable scene, or a chain gap from a dropped/conflicting batch).
      // Route the throw into the same halt-on-failure contract so one bad
      // slice degrades to "render the last coherent doc" instead of rejecting
      // the whole export.
      let result: ReturnType<Step["apply"]>;
      try {
        result = step.apply(doc);
      } catch (e) {
        failure = {
          failedAt: ev.sequence,
          reason: `step.apply threw: ${(e as Error).message}`,
        };
        return false;
      }
      if (result.failed || !result.doc) {
        failure = {
          failedAt: ev.sequence,
          reason: result.failed ?? "step.apply returned no doc",
        };
        return false;
      }
      doc = result.doc;
      applied += 1;
    }
    return true;
  }

  function advanceOne(): boolean {
    if (failure || index >= events.length) return false;
    const ev = events[index];
    index += 1;
    atSequence = ev.sequence;
    processEvent(ev);
    return failure === null;
  }

  return {
    get doc() {
      return doc;
    },
    get appliedSteps() {
      return applied;
    },
    get atSequence() {
      return atSequence;
    },
    get failure() {
      return failure;
    },
    applyUntil(targetSequence: number) {
      while (
        failure === null &&
        index < events.length &&
        events[index].sequence <= targetSequence
      ) {
        advanceOne();
      }
    },
    applyNext() {
      return advanceOne();
    },
  };
}

/**
 * Apply captured `doc.step` events to a starting document, all at once.
 *
 * Caller is responsible for filtering events to a single entityId (scene /
 * codex / snippet) so positions stay coherent. Non `doc.step` events and
 * events from unrelated domains are skipped.
 */
export function replayEditorSteps(
  schema: Schema,
  initialDoc: ProseMirrorNode,
  events: readonly ReplayEvent[],
): EditorReplayResult {
  const cursor = createReplayCursor(schema, initialDoc, events);
  cursor.applyUntil(Number.POSITIVE_INFINITY);
  const out: EditorReplayResult = {
    doc: cursor.doc,
    appliedSteps: cursor.appliedSteps,
  };
  if (cursor.failure) {
    out.failedAt = cursor.failure.failedAt;
    out.reason = cursor.failure.reason;
  }
  return out;
}

function isEditorBodyDomain(domain: string): boolean {
  return domain === "editor" || domain === "codex" || domain === "snippet";
}
