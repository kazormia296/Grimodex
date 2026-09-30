import type { WorkLayerModel } from "./types";

export function switchWorkLayerFocus(
  current: WorkLayerModel,
  targetId: string,
): WorkLayerModel {
  const previousFocus = current.focus;
  const requestedTarget = previousFocus?.later.find(
    (target) => target.id === targetId,
  );
  const nextFocus =
    current.allWork?.find(
      (item) => item.status === "waiting" && item.id === targetId,
    ) ?? (current.allWork == null ? requestedTarget : undefined);
  if (nextFocus == null) return current;

  const later =
    previousFocus == null
      ? (current.allWork ?? [])
          .filter((item) => item.status === "waiting" && item.id !== targetId)
          .map((item) => ({ id: item.id, title: item.title }))
      : [
          { id: previousFocus.id, title: previousFocus.title },
          ...previousFocus.later.filter((target) => target.id !== targetId),
        ];

  return {
    ...current,
    focus: {
      id: nextFocus.id,
      title: nextFocus.title,
      authorTasks: [],
      later,
    },
    allWork: current.allWork?.map((item) => {
      if (item.id === nextFocus.id) {
        return { ...item, status: "active", tag: "NOW" };
      }
      if (item.status === "active") {
        return {
          ...item,
          status: "waiting",
          tag: undefined,
          taskProgress: undefined,
        };
      }
      return item;
    }),
  };
}
