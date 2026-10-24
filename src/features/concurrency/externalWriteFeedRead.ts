import { db } from "@/db/client";
import { changeEvents } from "@/db/schema";
import { and, asc, eq, gt, ne } from "drizzle-orm";

type ChangeEventRow = typeof changeEvents.$inferSelect;

/**
 * The feed reads `change_events` as an own-data-read (O-2). Its D2a refusal is
 * temporary from activation stage 2 to stage 7 (and lasting while
 * unavailable), and the renderer cannot tell them apart, so the poll keeps
 * its cursor and retries for about two minutes (longer than the bounded
 * stages), then stops: a finite retry, never an endless one (Negative (11);
 * DR-DA2B-R5). A new Project open starts it again.
 */
const MAX_DENIED_POLLS = 160;
let deniedPolls = 0;

/** A new feed (or a stopped one) starts with the whole retry budget. */
export function resetDeniedPolls(): void {
  deniedPolls = 0;
}

/** Counts one D2a refusal of a poll and calls `stop` once the budget is spent. */
export function noteDeniedPoll(stop: () => void): void {
  if (++deniedPolls >= MAX_DENIED_POLLS) stop();
}

export async function fetchExternalRows(
  projectId: string,
  cursor: number,
  sessionId: string,
): Promise<ChangeEventRow[]> {
  const rows = await db
    .select()
    .from(changeEvents)
    .where(
      and(
        eq(changeEvents.projectId, projectId),
        gt(changeEvents.sequence, cursor),
        ne(changeEvents.sessionId, sessionId),
      ),
    )
    .orderBy(asc(changeEvents.sequence));
  deniedPolls = 0;
  return rows.filter((row) => row.sessionId !== sessionId);
}
