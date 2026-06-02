import { useEffect, useRef, useState } from "react";
import { CornerDownRight, MessageSquare, Send, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useEditorStore } from "@/features/editor/editorStore";
import { useAnnotationStore } from "./annotationStore";
import { closeAnnotation } from "./closeAnnotation";
import { replyToAnnotation } from "./api";
import type { PostEffectAnnotation } from "./types";

export interface PseudoThread {
  root: PostEffectAnnotation;
  replies: PostEffectAnnotation[];
}

/**
 * flat な annotation 配列から pseudo_comment のスレッド (root + replies) を組み立てる。
 *
 * dismiss は **スレッド単位** (UI 上「無視」ボタンは root にのみ存在し、root を
 * dismissed にするとスレッドごと非表示)。返信を個別に dismiss する導線は無いが、
 * backend cascade 等で返信が dismissed になった場合も root と同じ扱いで隠すよう
 * replies 側も status で除外し、表示の非対称を防ぐ。
 */
export function groupPseudoThreads(
  annotations: PostEffectAnnotation[],
): PseudoThread[] {
  const pseudo = annotations.filter((a) => a.category === "pseudo_comment");
  const repliesByParent = new Map<string, PostEffectAnnotation[]>();
  for (const a of pseudo) {
    if (!a.parentId) continue;
    const arr = repliesByParent.get(a.parentId) ?? [];
    arr.push(a);
    repliesByParent.set(a.parentId, arr);
  }
  const sortByCreated = (x: PostEffectAnnotation, y: PostEffectAnnotation) =>
    (x.createdAt ?? "").localeCompare(y.createdAt ?? "");
  return pseudo
    .filter((a) => a.parentId == null && a.status !== "dismissed")
    .sort(sortByCreated)
    .map((root) => ({
      root,
      replies: (repliesByParent.get(root.id) ?? [])
        .filter((r) => r.status !== "dismissed")
        .sort(sortByCreated),
    }));
}

function PersonaBadge({ persona }: { persona: string | null | undefined }) {
  if (!persona) return null;
  return (
    <span className="inline-flex shrink-0 items-center gap-0.5 rounded bg-indigo-500/15 px-1.5 py-0 text-[10px] text-indigo-600 dark:text-indigo-300">
      <MessageSquare size={9} /> {persona}
    </span>
  );
}

function ReplyRow({ reply }: { reply: PostEffectAnnotation }) {
  const isUser = reply.authorRole === "user";
  return (
    <div className="flex items-start gap-1.5 pl-3 text-xs">
      <CornerDownRight
        size={12}
        className="mt-0.5 shrink-0 text-muted-foreground/60"
      />
      <div className="flex flex-col gap-0.5">
        <span className="text-[10px] text-muted-foreground">
          {isUser ? "あなた" : (reply.persona ?? "AI")}
        </span>
        <p className="leading-snug">{reply.content}</p>
      </div>
    </div>
  );
}

interface Props {
  thread: PseudoThread;
  /** 返信や解決でデータが変わったあとに呼ばれる (親が再取得する) */
  onChanged: () => void;
  /** ヘッダにシーン名を出す場合 (Comments タブ横断表示用) */
  sceneLabel?: string;
  onJump?: () => void;
}

export function PseudoCommentThread({
  thread,
  onChanged,
  sceneLabel,
  onJump,
}: Props) {
  const { root, replies } = thread;
  const [replying, setReplying] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const editor = useEditorStore((s) => s.editor);
  const { focusedAnnotationId, setFocusedAnnotationId } = useAnnotationStore();
  const focused = focusedAnnotationId === root.id;
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (replying) inputRef.current?.focus();
  }, [replying]);

  async function submitReply() {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      await replyToAnnotation({ parentId: root.id, content: body });
      setText("");
      setReplying(false);
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function dismiss() {
    await closeAnnotation(root, "dismissed", editor);
    onChanged();
  }

  return (
    <div
      className={cn(
        "group flex flex-col gap-1.5 rounded-md border px-3 py-2 text-sm",
        focused
          ? "border-primary/60 bg-primary/5"
          : "border-border hover:border-muted-foreground/40",
      )}
    >
      <div className="flex items-start gap-2">
        <div className="flex flex-1 flex-wrap items-center gap-1.5">
          <PersonaBadge persona={root.persona} />
          {sceneLabel && (
            <button
              type="button"
              onClick={onJump}
              className="truncate text-[10px] text-muted-foreground hover:text-foreground"
            >
              {sceneLabel}
            </button>
          )}
        </div>
        <button
          type="button"
          aria-label="無視"
          title="無視"
          onClick={dismiss}
          className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-muted group-hover:opacity-100"
        >
          <X size={13} />
        </button>
      </div>

      <p
        role="button"
        tabIndex={0}
        onClick={() => {
          setFocusedAnnotationId(focused ? null : root.id);
          onJump?.();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            setFocusedAnnotationId(focused ? null : root.id);
            onJump?.();
          }
        }}
        className="cursor-pointer leading-snug"
      >
        {root.content}
      </p>

      {root.textSnapshot && (
        <blockquote className="border-l-2 border-muted-foreground/30 pl-2 text-xs text-muted-foreground line-clamp-2">
          {root.textSnapshot}
        </blockquote>
      )}

      {replies.length > 0 && (
        <div className="flex flex-col gap-1 border-t border-border/50 pt-1.5">
          {replies.map((r) => (
            <ReplyRow key={r.id} reply={r} />
          ))}
        </div>
      )}

      {replying ? (
        <div className="flex items-center gap-1.5 pt-1">
          <input
            ref={inputRef}
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void submitReply();
              }
              if (e.key === "Escape") {
                setReplying(false);
                setText("");
              }
            }}
            placeholder="返信を入力…"
            className="flex-1 rounded border border-border bg-background px-2 py-1 text-xs outline-none focus:border-primary"
          />
          <button
            type="button"
            disabled={busy || !text.trim()}
            onClick={() => void submitReply()}
            className="rounded p-1 text-primary hover:bg-primary/10 disabled:opacity-40"
          >
            <Send size={13} />
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setReplying(true)}
          className="self-start text-[11px] text-muted-foreground hover:text-foreground"
        >
          返信する
        </button>
      )}
    </div>
  );
}
