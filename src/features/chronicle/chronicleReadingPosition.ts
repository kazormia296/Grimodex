import type { EventRow, SceneEventRow } from "./api";
import { readingPos, type ReadingOrder } from "./chronicleSecrecy";

/**
 * The position filter of the Chronicle tool for the chat agent (chat IR S1-B,
 * DR-CHATIR-S1-30): an event that is placed after the Scene being written is
 * not given to the model. It is applied after the secrecy filter
 * (`isEventHiddenFromAi`) and takes the same input shape.
 *
 * The rule (confirmed △7 plan B, plan X):
 *  - an event no Scene is tied to passes (the filter says nothing about it);
 *  - among the Scenes the event is tied to that are in the reading order, the
 *    earliest one decides: it passes when its position is **at or before** the
 *    current Scene's (the current Scene itself passes), it is dropped when after;
 *  - an event tied only to Scenes outside the reading order is dropped
 *    (fail-closed: its position is unknown);
 *  - when the current Scene is not in the reading order the filter is not
 *    applied and everything passes (plan X; the IR side returns nothing then,
 *    and the secrecy filter has already hidden what it hides).
 *
 * The reading order is used whatever the project's phase axis is, as the
 * secrecy filter does. This is the opposite boundary of the IR's own rule
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
