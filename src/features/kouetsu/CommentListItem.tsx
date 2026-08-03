import { motion } from "motion/react";
import { User } from "lucide-react";
import { PseudoCommentThread } from "@/features/post-effect/PseudoCommentThread";
import { DURATIONS, EASINGS, VARIANTS } from "@/lib/animation";
import type { CommentListItem as CommentItem } from "./commentsAggregation";

interface Props {
  item: CommentItem;
  reducedMotion: boolean;
  jumpToHumanComment: (
    comment: Extract<CommentItem, { kind: "human" }>["comment"],
  ) => void;
  onPseudoChanged: () => void;
  onPseudoJump: () => void;
  jumpTitle: string;
}

/** コメント一覧の1項目。新規項目の入場を担当し、本文領域には影響しない。 */
export function CommentListItem({
  item,
  reducedMotion,
  jumpToHumanComment,
  onPseudoChanged,
  onPseudoJump,
  jumpTitle,
}: Props) {
  const motionProps = reducedMotion
    ? {
        initial: false as const,
        animate: undefined,
        exit: undefined,
        variants: undefined,
        transition: undefined,
      }
    : {
        initial: "initial" as const,
        animate: "animate" as const,
        exit: "exit" as const,
        variants: VARIANTS.slideUp,
        transition: { duration: DURATIONS.normal, ease: EASINGS.easeOut },
      };

  return (
    <motion.div
      layout={!reducedMotion}
      {...motionProps}
      className="will-change-transform"
    >
      {item.kind === "human" ? (
        <button
          type="button"
          onClick={() => jumpToHumanComment(item.comment)}
          title={jumpTitle}
          className="flex w-full items-start gap-1.5 rounded-md border border-border px-3 py-2 text-left text-sm hover:bg-accent/30"
        >
          <User size={13} className="mt-0.5 shrink-0 text-amber-500" />
          <div className="flex min-w-0 flex-col gap-1">
            <p className="leading-snug">{item.comment.text}</p>
            {item.comment.quote && (
              <blockquote className="border-l-2 border-muted-foreground/30 pl-2 text-xs text-muted-foreground line-clamp-2">
                {item.comment.quote}
              </blockquote>
            )}
          </div>
        </button>
      ) : (
        <PseudoCommentThread
          thread={item.thread}
          onChanged={onPseudoChanged}
          onJump={onPseudoJump}
        />
      )}
    </motion.div>
  );
}
