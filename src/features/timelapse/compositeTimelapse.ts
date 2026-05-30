/**
 * 執筆タイムラプス P5 compositor — merged schedule, multi-entity cursors,
 * chrome caption windows, and render-target selection.
 */

import type { Schema } from "@tiptap/pm/model";
import type { ChangeEvent } from "@/db/schema";
import { loadProjectChangeEvents } from "./queryEvents";
import {
  createReplayCursor,
  type ReplayCursor,
  type ReplayEvent,
} from "./replayEngine";
import { buildFrameSchedule } from "./frameProducer";
import { buildReplayStart } from "./replayStart";
import { loadLatestSnapshot } from "./snapshots";
import {
  collectOpenPanels,
  docStepEntityKeys,
  formatEventCaption,
  isSceneEditorBodyStep,
  parseEventPayload,
  renderKeyFromDocStep,
  type FormattedCaption,
  type RenderTargetKey,
} from "./formatEventCaption";

export type { RenderTargetKey };

export interface CompositeTimelapsePlan {
  /** All events used for scheduling (may be filtered in scene mode). */
  events: ChangeEvent[];
  /** doc.step replay cursors keyed by scene:/codex:/snippet: */
  cursors: Map<RenderTargetKey, ReplayCursor>;
  schedule: number[];
  sceneCount: number;
  eventCount: number;
  /** Per-frame caption lists aligned to schedule indices. */
  frameCaptions: FormattedCaption[][];
}

export interface BuildCompositePlanOptions {
  projectId: string;
  /** When set, only scene-attributed events + chrome are included. */
  sceneId?: string;
  fps?: number;
  targetDurationSec?: number;
  maxIdleMs?: number;
}

function isSceneChromeEvent(event: ChangeEvent, sceneId: string): boolean {
  if (event.sceneId === sceneId) return true;
  if (event.sceneId != null) return false;
  const chromeDomains = new Set([
    "chat",
    "layout",
    "map",
    "grid",
    "codex",
    "snippet",
  ]);
  return chromeDomains.has(event.domain);
}

function filterEventsForScene(
  rows: ChangeEvent[],
  sceneId: string,
): ChangeEvent[] {
  return rows.filter((e) => {
    if (isSceneEditorBodyStep(e) && e.sceneId !== sceneId) return false;
    if (e.domain === "editor" && e.opType === "doc.step" && e.sceneId !== sceneId) {
      return false;
    }
    return isSceneChromeEvent(e, sceneId);
  });
}

function hasExportableContent(events: ChangeEvent[], sceneId?: string): boolean {
  if (events.length === 0) return false;
  if (!sceneId) return true;
  const hasSceneBody = events.some((e) => isSceneEditorBodyStep(e) && e.sceneId === sceneId);
  const hasChrome = events.some((e) => isSceneChromeEvent(e, sceneId) && !isSceneEditorBodyStep(e));
  return hasSceneBody || hasChrome;
}

async function buildCursors(
  schema: Schema,
  projectId: string,
  docStepEvents: ReplayEvent[],
): Promise<Map<RenderTargetKey, ReplayCursor>> {
  const byKey = new Map<RenderTargetKey, ReplayEvent[]>();
  for (const ev of docStepEvents) {
    const key = renderKeyFromDocStep(ev as ChangeEvent);
    if (!key) continue;
    const list = byKey.get(key) ?? [];
    list.push(ev);
    byKey.set(key, list);
  }

  const cursors = new Map<RenderTargetKey, ReplayCursor>();
  for (const [key, evs] of byKey) {
    const [kind, entityId] = key.split(":") as [string, string];
    const snapshot =
      kind === "scene"
        ? await loadLatestSnapshot({
            projectId,
            domain: "editor",
            entityId,
          })
        : null;
    const start = (() => {
      try {
        return buildReplayStart(schema, evs, snapshot);
      } catch {
        return buildReplayStart(schema, evs, null);
      }
    })();
    cursors.set(
      key,
      createReplayCursor(schema, start.initialDoc, start.replayEvents),
    );
  }
  return cursors;
}

/**
 * Last doc.step at or before targetSequence → render key; on cursor failure keep prev.
 */
export function pickRenderTarget(
  events: readonly ChangeEvent[],
  targetSequence: number,
  cursors: Map<RenderTargetKey, ReplayCursor>,
  prevRenderKey: RenderTargetKey | null,
): RenderTargetKey | null {
  let candidate: RenderTargetKey | null = null;
  for (const ev of events) {
    if (ev.sequence > targetSequence) break;
    if (ev.opType !== "doc.step") continue;
    const key = renderKeyFromDocStep(ev);
    if (key) candidate = key;
  }
  if (!candidate) return prevRenderKey;

  const cursor = cursors.get(candidate);
  if (cursor?.failure) return prevRenderKey;
  return candidate;
}

function shouldSuppressCaption(
  event: ChangeEvent,
  docStepKeysUpToFrame: Set<string>,
): boolean {
  if (event.opType === "doc.step") return true;
  if (isSceneEditorBodyStep(event)) return true;

  if (
    event.domain === "codex" &&
    event.opType === "entry.update" &&
    event.entityId
  ) {
    if (docStepKeysUpToFrame.has(`codex:${event.entityId}`)) return true;
  }
  if (
    event.domain === "snippet" &&
    event.opType === "snippet.update" &&
    event.entityId
  ) {
    if (docStepKeysUpToFrame.has(`snippet:${event.entityId}`)) return true;
  }
  return false;
}

function buildFrameCaptions(
  events: ChangeEvent[],
  schedule: number[],
): FormattedCaption[][] {
  const out: FormattedCaption[][] = schedule.map(() => []);
  let prevLayoutPanels: string[] | null = null;

  for (let f = 0; f < schedule.length; f += 1) {
    const prevTarget = f > 0 ? schedule[f - 1] : 0;
    const current = schedule[f];
    const windowEvents = events.filter(
      (e) => e.sequence > prevTarget && e.sequence <= current,
    );
    // Cumulative doc.step keys through this frame (not window-only) so
    // entry.update after doc.step in an adjacent frame still suppresses diffs.
    const docStepKeysUpToFrame = docStepEntityKeys(
      events.filter((e) => e.sequence <= current && e.opType === "doc.step"),
    );
    const captions: FormattedCaption[] = [];

    for (const ev of windowEvents) {
      if (shouldSuppressCaption(ev, docStepKeysUpToFrame)) {
        if (ev.domain === "layout" && ev.opType === "layout.snapshot") {
          prevLayoutPanels = collectOpenPanels(parseEventPayload(ev));
        }
        continue;
      }
      const cap = formatEventCaption(ev, { prevLayoutPanels });
      if (cap) captions.push(cap);
      if (ev.domain === "layout" && ev.opType === "layout.snapshot") {
        prevLayoutPanels = collectOpenPanels(parseEventPayload(ev));
      }
    }

    out[f] = captions.slice(-2);
  }
  return out;
}

/**
 * Build a composite timelapse plan (project-wide or single-scene attribution).
 */
export async function buildCompositeTimelapsePlan(
  opts: BuildCompositePlanOptions,
): Promise<CompositeTimelapsePlan> {
  const rows = await loadProjectChangeEvents(opts.projectId);
  const events = opts.sceneId
    ? filterEventsForScene(rows, opts.sceneId)
    : rows;

  if (!hasExportableContent(events, opts.sceneId)) {
    throw new Error("timelapse: no change events to export");
  }

  const { getEditorExtensions } = await import("@/features/editor/extensions");
  const { getSchema } = await import("@tiptap/core");
  const schema = getSchema(getEditorExtensions());

  const docStepEvents = events.filter((e) => e.opType === "doc.step");
  const cursors = await buildCursors(schema, opts.projectId, docStepEvents);

  const schedule = buildFrameSchedule(events, {
    fps: opts.fps,
    targetDurationSec: opts.targetDurationSec,
    ...(opts.maxIdleMs !== undefined ? { maxIdleMs: opts.maxIdleMs } : {}),
  });

  const frameCaptions = buildFrameCaptions(events, schedule);

  const sceneIds = new Set(
    events
      .filter((e) => isSceneEditorBodyStep(e) && e.sceneId)
      .map((e) => e.sceneId as string),
  );

  return {
    events,
    cursors,
    schedule,
    sceneCount: sceneIds.size,
    eventCount: events.length,
    frameCaptions,
  };
}

/**
 * Advance all cursors that could have changed by targetSequence (only the active
 * target needs the doc state, but we advance the active one fully).
 */
export function advanceCursorForTarget(
  cursors: Map<RenderTargetKey, ReplayCursor>,
  renderKey: RenderTargetKey | null,
  targetSequence: number,
): ReplayCursor | null {
  if (!renderKey) return null;
  const cursor = cursors.get(renderKey);
  if (!cursor || cursor.failure) return cursor ?? null;
  cursor.applyUntil(targetSequence);
  return cursor;
}

export function countSceneBodySteps(events: readonly ChangeEvent[]): number {
  return events.filter(isSceneEditorBodyStep).length;
}
