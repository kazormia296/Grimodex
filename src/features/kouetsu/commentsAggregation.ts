import type { ExtractedMark } from "@/features/export/zipExport/marksExtractor";
import type { PseudoThread } from "@/features/post-effect/PseudoCommentThread";

export type Filter = "all" | "human" | "ai";

export interface HumanComment {
  sceneId: string;
  sceneTitle: string;
  text: string;
  createdAt: string | null;
}

export interface SceneGroup {
  sceneId: string;
  sceneTitle: string;
  human: HumanComment[];
  threads: PseudoThread[];
}

/**
 * Map the `comment` marks of one scene's doc into HumanComment rows.
 * Skips non-`comment` marks and empty/whitespace-only text; defaults
 * `createdAt` to null when absent.
 */
export function humanCommentsFromMarks(
  sceneId: string,
  sceneTitle: string,
  marks: ExtractedMark[],
): HumanComment[] {
  const out: HumanComment[] = [];
  for (const m of marks) {
    if (m.type !== "comment") continue;
    const text = String(m.attrs.text ?? "").trim();
    if (!text) continue;
    out.push({
      sceneId,
      sceneTitle,
      text,
      createdAt: (m.attrs.createdAt as string | null) ?? null,
    });
  }
  return out;
}

/**
 * Merge human comments and pseudo-comment threads into per-scene groups.
 * `filter` "human" drops threads, "ai" drops human, "all" keeps both.
 * Threads whose root has no sceneId are skipped; empty groups are dropped.
 */
export function buildCommentGroups(
  human: HumanComment[],
  threads: PseudoThread[],
  filter: Filter,
  resolveTitle: (sceneId: string) => string,
): SceneGroup[] {
  const acc = new Map<string, SceneGroup>();
  const ensure = (sceneId: string): SceneGroup => {
    const g = acc.get(sceneId) ?? {
      sceneId,
      sceneTitle: resolveTitle(sceneId),
      human: [],
      threads: [],
    };
    acc.set(sceneId, g);
    return g;
  };
  if (filter !== "ai") {
    for (const c of human) ensure(c.sceneId).human.push(c);
  }
  if (filter !== "human") {
    for (const t of threads) {
      if (!t.root.sceneId) continue;
      ensure(t.root.sceneId).threads.push(t);
    }
  }
  return [...acc.values()].filter(
    (g) => g.human.length > 0 || g.threads.length > 0,
  );
}
