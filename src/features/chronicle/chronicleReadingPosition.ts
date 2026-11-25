import type { EventRow, SceneEventRow } from "./api";
import { readingPos, type ReadingOrder } from "./chronicleSecrecy";

/**
 * The position filter of the Chronicle tool for the chat agent (chat IR S1-B,
 * DR-CHATIR-S1-30): an event that is placed after the Scene being written is
 * not given to the model. The IR secrecy approximation below is dormant, and
 * event-secrecy decisions have been retired.
 *
 * The rule (confirmed △7 plan B, plan X):
 *  - an event no Scene is tied to passes (the filter says nothing about it);
 *  - among the Scenes the event is tied to that are in the reading order, the
 *    earliest one decides: it passes when its position is **at or before** the
 *    current Scene's (the current Scene itself passes), it is dropped when after;
 *  - an event tied only to Scenes outside the reading order is dropped
 *    (fail-closed: its position is unknown);
 *  - when the current Scene is not in the reading order the filter is not
 *    applied and everything passes (plan X; the IR side returns nothing then).
 *
 * The reading order is used whatever the project's phase axis is. This is the opposite boundary of the IR's own rule
 * (Native drops the current Scene and later ones); the asymmetry is by design.
 *
 * Returns `true` when the event may be given to the model.
 */
export function isEventBeforeOrAtScene(
  event: Pick<EventRow, "id">,
  currentSceneId: string,
  ctx: { readingOrder: ReadingOrder; sceneEvents: SceneEventRow[] },
): boolean {
  if (!currentSceneId || !ctx.readingOrder.has(currentSceneId)) return true;
  let earliest = Number.POSITIVE_INFINITY;
  let tied = false;
  for (const link of ctx.sceneEvents) {
    if (link.eventId !== event.id) continue;
    tied = true;
    if (!ctx.readingOrder.has(link.sceneId)) continue;
    const position = readingPos(ctx.readingOrder, link.sceneId);
    if (position < earliest) earliest = position;
  }
  if (!tied) return true;
  // Tied only to Scenes outside the reading order: `earliest` is still infinite.
  if (earliest === Number.POSITIVE_INFINITY) return false;
  return earliest <= readingPos(ctx.readingOrder, currentSceneId);
}

/**
 * The approximation of rule (4) (chat IR S1-A2b, DR-CHATIR-S1-45): what stands
 * in for "drop the event the IR's own rule would drop" when Native's exclusion
 * is not at hand. Only a secret event is judged; an event that is not secret
 * passes.
 *
 * The premise this was written on ("the events an import makes are always
 * secret") no longer holds: since CSR/1 (N6) an import makes them unmarked, so
 * only events marked before that are judged. Revisit the approximation before
 * chat IR is opened (CSR/1 N9).
 *
 * A secret event passes only when **every** Scene it is tied to is placed
 * strictly before the current Scene (plan A of the contract's 3.4 (3)). So the
 * current Scene's own events, and those that span past it, do not pass.
 *
 *  - a tied Scene outside the reading order: position unknown, does not pass;
 *  - the current Scene empty or outside the reading order: does not pass;
 *  - a secret event no Scene is tied to: nothing places it at or after the
 *    current Scene, so it passes (an event the IR made always has a tie).
 *
 * This approximation is dormant. Returns `true` when the event may be given.
 */
export function passesIrExclusionApproximation(
  event: Pick<EventRow, "id" | "secret">,
  currentSceneId: string,
  ctx: { readingOrder: ReadingOrder; sceneEvents: SceneEventRow[] },
): boolean {
  if (!event.secret) return true;
  if (!currentSceneId || !ctx.readingOrder.has(currentSceneId)) return false;
  const current = readingPos(ctx.readingOrder, currentSceneId);
  for (const link of ctx.sceneEvents) {
    if (link.eventId !== event.id) continue;
    if (!ctx.readingOrder.has(link.sceneId)) return false;
    if (readingPos(ctx.readingOrder, link.sceneId) >= current) return false;
  }
  return true;
}
