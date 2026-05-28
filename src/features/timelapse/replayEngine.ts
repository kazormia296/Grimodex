/**
 * 執筆タイムラプス replay engine — minimal P2 surface (Editor only).
 *
 * Given an initial ProseMirror doc and a sequence of step JSONs captured by
 * the recorder, applies them in order and returns the resulting doc. Used by
 * the in-app TimelapsePlayer and the offscreen video renderer.
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

/**
 * Apply captured `doc.step` events to a starting document.
 *
 * Caller is responsible for filtering events to a single entityId (scene /
 * codex / snippet) so positions stay coherent. Non `doc.step` events and
 * events from unrelated domains are skipped.
 */
export function replayEditorSteps(
  schema: Schema,
  initialDoc: ProseMirrorNode,
  events: readonly Pick<
    ChangeEvent,
    "domain" | "opType" | "payload" | "sequence"
  >[],
): EditorReplayResult {
  let doc = initialDoc;
  let applied = 0;
  for (const ev of events) {
    if (ev.opType !== "doc.step") continue;
    if (!isEditorBodyDomain(ev.domain)) continue;
    let payload: { steps?: unknown };
    try {
      payload = JSON.parse(ev.payload);
    } catch (e) {
      return {
        doc,
        appliedSteps: applied,
        failedAt: ev.sequence,
        reason: `payload not JSON: ${(e as Error).message}`,
      };
    }
    if (!Array.isArray(payload.steps)) continue;
    for (const rawStep of payload.steps) {
      let step: Step;
      try {
        step = Step.fromJSON(schema, rawStep as never);
      } catch (e) {
        return {
          doc,
          appliedSteps: applied,
          failedAt: ev.sequence,
          reason: `Step.fromJSON failed: ${(e as Error).message}`,
        };
      }
      const result = step.apply(doc);
      if (result.failed || !result.doc) {
        return {
          doc,
          appliedSteps: applied,
          failedAt: ev.sequence,
          reason: result.failed ?? "step.apply returned no doc",
        };
      }
      doc = result.doc;
      applied += 1;
    }
  }
  return { doc, appliedSteps: applied };
}

function isEditorBodyDomain(domain: string): boolean {
  return domain === "editor" || domain === "codex" || domain === "snippet";
}
