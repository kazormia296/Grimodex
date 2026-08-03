import type { PseudoThread } from "@/features/post-effect/PseudoCommentThread";
import { compareInstantValues } from "@/lib/time";

export type Filter = "all" | "human" | "ai";
export type CommentSortOrder = "scene" | "newest" | "oldest";

export interface HumanComment {
  sceneId: string;
  sceneTitle: string;
  /** コメント本文（トリム済み） */
  text: string;
  /** コメントが紐づく本文の抜粋（対象範囲のテキスト、トリム済み） */
  quote: string;
  createdAt: string | null;
  /**
   * 同一シーン内に (text, createdAt) が等しいコメントが複数あるときの出現順
   * index (0 始まり)。ライブ doc 上で該当 mark を一意に特定するために使う。
   */
  ordinal: number;
}

export type CommentListItem =
  | { kind: "human"; comment: HumanComment }
  | { kind: "pseudo"; thread: PseudoThread };

export interface SceneGroup {
  sceneId: string;
  sceneTitle: string;
  human: HumanComment[];
  threads: PseudoThread[];
  /** Human comments and pseudo-comment roots in the current display order. */
  items: CommentListItem[];
}

interface PmTextMark {
  type: string;
  attrs?: Record<string, unknown>;
}

interface PmDocNode {
  type: string;
  text?: string;
  marks?: PmTextMark[];
  content?: PmDocNode[];
}

/**
 * シーンの ProseMirror JSON から人間コメント (`comment` mark) を抽出する。
 *
 * - 連続する同一 `comment` mark の text node を 1 コメントへ結合し、対象本文の抜粋
 *   (`quote`) を復元する。mark が複数 text node に跨っても重複コメントにしない
 *   （`humanCommentsFromMarks` 時代の潜在重複バグも併せて解消）。
 * - 本文 (`text` attr) が空/空白のみのコメントはスキップ（従来動作を踏襲）。
 * - 同一 (text, createdAt) のコメントには出現順 `ordinal` を振り、ライブ doc 上で
 *   該当 mark を一意に特定できるようにする。`createdAt` 欠如時は null。
 */
export function humanCommentsFromDoc(
  sceneId: string,
  sceneTitle: string,
  contentJson: string,
): HumanComment[] {
  if (!contentJson || contentJson === "{}") return [];
  let doc: PmDocNode;
  try {
    doc = JSON.parse(contentJson) as PmDocNode;
  } catch {
    return [];
  }

  interface Run {
    bodyRaw: string;
    createdAt: string | null;
    quote: string;
  }
  const runs: Run[] = [];
  let current: Run | null = null;
  const flush = () => {
    if (current) {
      runs.push(current);
      current = null;
    }
  };

  const walk = (node: PmDocNode): void => {
    if (node.type === "text") {
      const cm = (node.marks ?? []).find((m) => m.type === "comment");
      if (cm) {
        const bodyRaw = String(cm.attrs?.text ?? "");
        const createdAt = (cm.attrs?.createdAt as string | null) ?? null;
        const chunk = node.text ?? "";
        if (
          current &&
          current.bodyRaw === bodyRaw &&
          current.createdAt === createdAt
        ) {
          current.quote += chunk;
        } else {
          flush();
          current = { bodyRaw, createdAt, quote: chunk };
        }
      } else {
        flush();
      }
      return;
    }
    // 非 text ノード（段落境界・改行・ruby 等）に入ると comment run は途切れる。
    flush();
    for (const child of node.content ?? []) walk(child);
    flush();
  };
  walk(doc);
  flush();

  const out: HumanComment[] = [];
  const seen = new Map<string, number>();
  for (const r of runs) {
    const text = r.bodyRaw.trim();
    if (!text) continue;
    // createdAt + 本文 の重複検出キー。text は任意文字列なので区切り文字衝突を
    // 避けるため JSON.stringify で完全に injective 化する(分解は行わない)。
    const key = JSON.stringify([r.createdAt ?? "", text]);
    const ordinal = seen.get(key) ?? 0;
    seen.set(key, ordinal + 1);
    out.push({
      sceneId,
      sceneTitle,
      text,
      quote: r.quote.trim(),
      createdAt: r.createdAt,
      ordinal,
    });
  }
  return out;
}

/**
 * アクティブシーン宛ての操作（疑似コメント生成等）の結果が、現在のスコープ
 * フィルタで不可視になるか。folder スコープでアクティブシーンが配下に無い
 * ときだけ true（project=null は全件表示、シーン未選択 "" は対象外）。
 */
export function isActiveSceneOutOfScope(
  sceneIds: ReadonlySet<string> | null,
  activeSceneId: string,
): boolean {
  return (
    sceneIds !== null && activeSceneId !== "" && !sceneIds.has(activeSceneId)
  );
}

/**
 * Merge human comments and pseudo-comment threads into per-scene groups.
 * `filter` "human" drops threads, "ai" drops human, "all" keeps both.
 * Threads whose root has no sceneId are skipped; empty groups are dropped.
 * `sceneIds` はスコープ絞り込み（null/省略 = 全シーン。空集合 = 0 件）。
 */
export function buildCommentGroups(
  human: HumanComment[],
  threads: PseudoThread[],
  filter: Filter,
  resolveTitle: (sceneId: string) => string,
  sceneIds: ReadonlySet<string> | null = null,
): SceneGroup[] {
  const inScope = (sceneId: string) =>
    sceneIds === null || sceneIds.has(sceneId);
  const acc = new Map<string, SceneGroup>();
  const ensure = (sceneId: string): SceneGroup => {
    const g = acc.get(sceneId) ?? {
      sceneId,
      sceneTitle: resolveTitle(sceneId),
      human: [],
      threads: [],
      items: [],
    };
    acc.set(sceneId, g);
    return g;
  };
  if (filter !== "ai") {
    for (const c of human) {
      if (inScope(c.sceneId)) ensure(c.sceneId).human.push(c);
    }
  }
  if (filter !== "human") {
    for (const t of threads) {
      if (!t.root.sceneId) continue;
      if (inScope(t.root.sceneId)) ensure(t.root.sceneId).threads.push(t);
    }
  }
  return [...acc.values()]
    .filter((g) => g.human.length > 0 || g.threads.length > 0)
    .map((g) => ({
      ...g,
      items: [
        ...g.human.map((comment) => ({ kind: "human" as const, comment })),
        ...g.threads.map((thread) => ({ kind: "pseudo" as const, thread })),
      ],
    }));
}

function createdAtForItem(item: CommentListItem): string | null {
  return item.kind === "human"
    ? item.comment.createdAt
    : item.thread.root.createdAt;
}

export function commentListItemKey(item: CommentListItem): string {
  return item.kind === "human"
    ? `human:${item.comment.sceneId}:${item.comment.createdAt ?? ""}:${item.comment.text}:${item.comment.ordinal}`
    : `pseudo:${item.thread.root.id}`;
}

function stableKeyForItem(item: CommentListItem): string {
  return commentListItemKey(item);
}

function compareItems(
  left: CommentListItem,
  right: CommentListItem,
  order: "newest" | "oldest",
): number {
  const timestamp = compareInstantValues(
    createdAtForItem(left),
    createdAtForItem(right),
    order === "newest" ? "descending" : "ascending",
  );
  return (
    timestamp || stableKeyForItem(left).localeCompare(stableKeyForItem(right))
  );
}

/**
 * コメント一覧の表示順を適用する。
 *
 * `scene` は従来どおりシーン順を保ち、`newest` / `oldest` は人間コメントと
 * 疑似コメントを同じ時系列へ並べる。グループも代表コメントの時刻で並べるため、
 * 新しいコメントが別シーンに追加されても一覧の上端へ移動する。
 */
export function sortCommentGroups(
  groups: SceneGroup[],
  order: CommentSortOrder,
): SceneGroup[] {
  if (order === "scene") {
    return groups.map((group) => ({ ...group, items: [...group.items] }));
  }

  const sortedGroups = groups.map((group) => ({
    ...group,
    items: [...group.items].sort((left, right) =>
      compareItems(left, right, order),
    ),
  }));
  return sortedGroups.sort((left, right) => {
    const itemOrder = compareItems(left.items[0], right.items[0], order);
    return itemOrder || left.sceneId.localeCompare(right.sceneId);
  });
}
