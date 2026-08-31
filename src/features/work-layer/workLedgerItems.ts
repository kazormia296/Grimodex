import type { WorkLayerModel, WorkLedgerItemView } from "./types";

const DISPOSITION_TAGS = {
  snoozed: "SNOOZE",
  held: "HOLD",
  "basis-ignored": "BASIS IGNORED",
  dismissed: "DISMISSED",
  legacy: "LEGACY",
} as const;

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
    ...model.disposedAttention.map((item) => ({
      id: `disposed:${item.id}`,
      title: item.title,
      status: "held" as const,
      tag: DISPOSITION_TAGS[item.disposition],
    })),
  ];
}
