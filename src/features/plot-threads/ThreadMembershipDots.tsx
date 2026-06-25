import type { PlotThreadRow } from "./api";

const MAX_DOTS = 4;

interface Props {
  /** Plot-thread ids this scene belongs to (deduped, stable reference). */
  threadIds?: string[];
  /** Resolver for thread id → row (name/color). Stable reference. */
  threadsById: Map<string, PlotThreadRow>;
}

/**
 * Small colored dots showing which plot threads (subplots) a scene belongs to —
 * the Scenes-panel analogue of the Timeline lanes. Mirrors LabelDots in size and
 * overflow behavior; colors use the same `thread.color ?? var(--primary)`
 * resolution as the Timeline so dots match their lanes.
 */
export function ThreadMembershipDots({ threadIds, threadsById }: Props) {
  if (!threadIds || threadIds.length === 0) return null;

  const seen = new Set<string>();
  const threads = threadIds
    .map((id) => threadsById.get(id))
    .filter((t): t is PlotThreadRow => {
      if (!t || seen.has(t.id)) return false;
      seen.add(t.id);
      return true;
    });

  if (threads.length === 0) return null;

  const shown = threads.slice(0, MAX_DOTS);
  const extra = threads.length - shown.length;

  return (
    <span className="ml-1 flex flex-shrink-0 items-center gap-0.5">
      {shown.map((thread) => (
        <span
          key={thread.id}
          className="inline-block h-1.5 w-1.5 rounded-full"
          style={{ backgroundColor: thread.color ?? "var(--primary)" }}
          title={thread.name}
        />
      ))}
      {extra > 0 && (
        <span className="text-[9px] leading-none text-muted-foreground">
          +{extra}
        </span>
      )}
    </span>
  );
}
