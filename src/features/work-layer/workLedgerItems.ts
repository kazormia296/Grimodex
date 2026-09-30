import type {
  DisposedAttentionView,
  WorkLayerModel,
  WorkLedgerItemView,
} from "./types";

const DISPOSITION_TAGS = {
  snoozed: "SNOOZE",
  held: "HOLD",
  "basis-ignored": "BASIS IGNORED",
  dismissed: "DISMISSED",
  legacy: "LEGACY",
} as const;

/**
 * A disposed Finding retains its finding ID as the ledger identity. The
 * prefix keeps it distinct from author-created Work IDs without falling back
 * to a mutable title.
 */
export function disposedFindingLedgerItemId(findingId: string): string {
  return `disposed:${findingId}`;
}

export function createDisposedWorkLedgerItem(
  finding: DisposedAttentionView,
): WorkLedgerItemView {
  return {
    id: disposedFindingLedgerItemId(finding.id),
    title: finding.title,
    status: "held",
    tag: DISPOSITION_TAGS[finding.disposition],
  };
}

export function deriveAllWork(
  model: WorkLayerModel,
): readonly WorkLedgerItemView[] {
  if (model.allWork != null) return model.allWork;

  const focus = model.focus;
  return [
    ...(focus == null
      ? []
      : [
          {
            id: `focus:${focus.id}`,
            title: focus.title,
            status: "active" as const,
            taskProgress: {
              completed: focus.authorTasks.filter((task) => task.completed)
                .length,
              total: focus.authorTasks.length,
            },
            tag: "NOW",
          },
        ]),
    ...(focus?.later.map((item) => ({
      id: `later:${item.id}`,
      title: item.title,
      status: "waiting" as const,
    })) ?? []),
    ...model.disposedAttention.map(createDisposedWorkLedgerItem),
  ];
}
