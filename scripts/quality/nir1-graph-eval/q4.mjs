// CP-4 S1f: q4（K6/4:133「Native の時計の受渡しから決着まで、決着から通知まで、子の
// 内訳」。開示だけ）の分布。R7 の記録の `followUp.q4`（k64-record.mjs が作る）を読む。
// 決着から通知までは、通知に Native の時刻が無く、renderer の時計と混ぜないので測らない
// （「not-measured」と書く）。代わりに renderer の時計の「親の公開から通知まで」を開示する。
//
// Pure module.

import { finite } from "./join.mjs";
import { distribution } from "./stats.mjs";

/** q4 distributions of a set of samples (K6/4-P3; disclosure only). */
export function summarizeQ4(samples) {
  const records = samples
    .map((row) => row.followUp?.q4)
    .filter((value) => value && typeof value === "object");
  const values = (pick) => records.map(pick).filter(finite);
  return {
    clock: "native-ns, disclosure only (K6/4:133)",
    parentHandOverToSettledMs: distribution(
      values((row) => row.parent?.handOverToSettledMs),
    ),
    parentTicketToSettledMs: distribution(
      values((row) => row.parent?.ticketToSettledMs),
    ),
    noticeAfterParentPublishMs: distribution(
      values((row) => row.noticeAfterParentPublishMs),
    ),
    childBeginMs: distribution(values((row) => row.child?.beginMs)),
    childNativeRawReadyElapsedMs: distribution(
      values((row) => row.child?.nativeRawReadyElapsedMs),
    ),
    settledToNotice: "not-measured:no-native-notice-time",
  };
}
