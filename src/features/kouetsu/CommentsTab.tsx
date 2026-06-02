import { useCallback, useEffect, useMemo, useState } from "react";
import { and, eq } from "drizzle-orm";
import { Loader2, MessageSquare, RefreshCw, User } from "lucide-react";
import { db } from "@/db/client";
import { treeNodes } from "@/db/schema";
import { cn } from "@/lib/utils";
import { useTreeStore } from "@/features/tree/treeStore";
import { extractMarksFromPmDoc } from "@/features/export/zipExport/marksExtractor";
import { listAnnotationsForProject } from "@/features/post-effect/api";
import {
  groupPseudoThreads,
  PseudoCommentThread,
  type PseudoThread,
} from "@/features/post-effect/PseudoCommentThread";

interface HumanComment {
  sceneId: string;
  sceneTitle: string;
  text: string;
  createdAt: string | null;
}

type Filter = "all" | "human" | "ai";

async function loadHumanComments(projectId: string): Promise<HumanComment[]> {
  const rows = await db
    .select({
      id: treeNodes.id,
      title: treeNodes.title,
      content: treeNodes.content,
    })
    .from(treeNodes)
    .where(
      and(eq(treeNodes.projectId, projectId), eq(treeNodes.nodeType, "scene")),
    );

  const out: HumanComment[] = [];
  for (const r of rows) {
    const { marks } = extractMarksFromPmDoc(r.content ?? "{}");
    for (const m of marks) {
      if (m.type !== "comment") continue;
      const text = String(m.attrs.text ?? "").trim();
      if (!text) continue;
      out.push({
        sceneId: r.id,
        sceneTitle: r.title,
        text,
        createdAt: (m.attrs.createdAt as string | null) ?? null,
      });
    }
  }
  return out;
}

interface SceneGroup {
  sceneId: string;
  sceneTitle: string;
  human: HumanComment[];
  threads: PseudoThread[];
}

export function CommentsTab() {
  const projectId = useTreeStore((s) => s.projectId);
  const scenes = useTreeStore((s) => s.scenes);
  const [human, setHuman] = useState<HumanComment[]>([]);
  const [threads, setThreads] = useState<PseudoThread[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");

  const sceneTitle = useCallback(
    (sceneId: string) => scenes.find((s) => s.id === sceneId)?.title ?? sceneId,
    [scenes],
  );

  // 人間コメントは CommentMark で doc 焼き込み → 集約には全シーン本文の
  // JSON.parse + extractMarksFromPmDoc 走査が要る(重い)。annotation(疑似コメント)
  // は専用テーブルからの軽量 SELECT。両者を分離して別々に再取得できるようにする。
  const reloadHuman = useCallback(async () => {
    if (!projectId) return;
    setHuman(await loadHumanComments(projectId));
  }, [projectId]);

  // 疑似コメントの dismiss/返信は人間 CommentMark を変更し得ない(annotation テーブル
  // のみ操作)。スレッド操作後に全シーン本文を再走査する loadHumanComments は完全な
  // 無駄だったので annotation だけ silently 再取得する（所見#6）。loading スピナーも
  // 出さず triage ループ(dismiss/返信連打)中のチラつきを防ぐ。
  const reloadAnnotations = useCallback(async () => {
    if (!projectId) return;
    try {
      const projAnns = await listAnnotationsForProject({
        projectId,
        status: "open",
      });
      setThreads(groupPseudoThreads(projAnns.annotations));
    } catch (e) {
      console.error("comments annotation reload error", e);
    }
  }, [projectId]);

  const reload = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      await Promise.all([reloadHuman(), reloadAnnotations()]);
    } catch (e) {
      console.error("comments aggregate load error", e);
    } finally {
      setLoading(false);
    }
  }, [projectId, reloadHuman, reloadAnnotations]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const groups = useMemo<SceneGroup[]>(() => {
    const acc = new Map<string, SceneGroup>();
    const ensure = (sceneId: string): SceneGroup => {
      const g = acc.get(sceneId) ?? {
        sceneId,
        sceneTitle: sceneTitle(sceneId),
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
  }, [human, threads, filter, sceneTitle]);

  const totalCount = groups.reduce(
    (n, g) => n + g.human.length + g.threads.length,
    0,
  );

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border bg-muted/20 px-2 py-1 text-xs">
        <div className="flex items-center gap-1">
          {(
            [
              ["all", "すべて"],
              ["human", "手動"],
              ["ai", "AI"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setFilter(id)}
              className={cn(
                "rounded px-2 py-0.5",
                filter === id
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent",
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => void reload()}
          title="再読み込み"
          className="rounded p-1 text-muted-foreground hover:bg-accent"
        >
          <RefreshCw size={12} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 size={16} className="animate-spin text-muted-foreground" />
          </div>
        ) : totalCount === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-8 text-center text-xs text-muted-foreground">
            <MessageSquare size={18} />
            <span>コメントはありません</span>
            <span className="text-[10px] text-muted-foreground/70">
              本文を選択して Ctrl+Shift+M で手動コメント、
              <br />
              批評タブの疑似コメントもここに集約されます
            </span>
          </div>
        ) : (
          <div className="flex flex-col gap-0">
            {groups.map((g) => (
              <div key={g.sceneId} className="flex flex-col">
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() =>
                    useTreeStore.getState().setActiveScene(g.sceneId)
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ")
                      useTreeStore.getState().setActiveScene(g.sceneId);
                  }}
                  className="sticky top-0 z-10 flex cursor-pointer items-center gap-1.5 border-b border-border bg-muted/30 px-3 py-1 text-xs font-medium text-muted-foreground hover:bg-muted/50"
                >
                  <span className="truncate">{g.sceneTitle}</span>
                  <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] leading-none">
                    {g.human.length + g.threads.length}
                  </span>
                </div>
                <div className="flex flex-col gap-2 p-2">
                  {g.human.map((c, i) => (
                    <button
                      key={`h-${g.sceneId}-${i}`}
                      type="button"
                      onClick={() =>
                        useTreeStore.getState().setActiveScene(c.sceneId)
                      }
                      className="flex items-start gap-1.5 rounded-md border border-border px-3 py-2 text-left text-sm hover:bg-accent/30"
                    >
                      <User
                        size={13}
                        className="mt-0.5 shrink-0 text-amber-500"
                      />
                      <p className="leading-snug">{c.text}</p>
                    </button>
                  ))}
                  {g.threads.map((t) => (
                    <PseudoCommentThread
                      key={t.root.id}
                      thread={t}
                      onChanged={() => void reloadAnnotations()}
                      onJump={() =>
                        t.root.sceneId &&
                        useTreeStore.getState().setActiveScene(t.root.sceneId)
                      }
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
