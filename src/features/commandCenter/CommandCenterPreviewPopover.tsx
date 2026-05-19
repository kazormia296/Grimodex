import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import {
  Popover,
  PopoverContent,
  PopoverAnchor,
} from "@/components/ui/popover";
import { previewCache } from "./lib/previewCache";
import type { PreviewContent } from "./lib/previewCache";
import { buildLexicalPreview } from "./preview/lexicalPreview";
import { fetchSemanticPreview } from "./preview/semanticPreview";
import type { CommandCenterItem } from "./providers/types";

const HOVER_DELAY_MS = 400;

interface CommandCenterPreviewPopoverProps {
  item: CommandCenterItem;
  /** ホバー対象になっている行か (panel 側 hoveredItemId と一致) */
  active: boolean;
  /** 子は row 本体。Popover の anchor として包む */
  children: ReactNode;
}

/**
 * 行 hover → 400ms 後にプレビュー (前後 ±100 文字 / lexical は excerpt) を popover で出す。
 * 同じ itemId への再 hover はキャッシュ Hit で即時表示。
 */
export function CommandCenterPreviewPopover({
  item,
  active,
  children,
}: CommandCenterPreviewPopoverProps) {
  const [content, setContent] = useState<PreviewContent | null>(null);
  const [open, setOpen] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    if (!active) {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
      cancelledRef.current = true;
      setOpen(false);
      return;
    }
    cancelledRef.current = false;
    // キャッシュ Hit なら即時開く
    const cached = previewCache.get(item.id);
    if (cached) {
      setContent(cached);
      setOpen(true);
      return;
    }
    timerRef.current = setTimeout(() => {
      void resolvePreview(item).then((preview) => {
        if (cancelledRef.current || preview === null) return;
        previewCache.set(item.id, preview);
        setContent(preview);
        setOpen(true);
      });
    }, HOVER_DELAY_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [active, item]);

  return (
    <Popover open={open}>
      <PopoverAnchor asChild>{children}</PopoverAnchor>
      <PopoverContent
        side="left"
        align="start"
        avoidCollisions
        collisionPadding={16}
        className="w-80 max-w-[90vw] text-xs"
      >
        {content && <PreviewBody content={content} />}
      </PopoverContent>
    </Popover>
  );
}

async function resolvePreview(
  item: CommandCenterItem,
): Promise<PreviewContent | null> {
  if (item.kind === "semantic-chunk") {
    const raw = item.id.split(":");
    // id: "semantic-chunk:<sceneId>:<charStart>:<charEnd>"
    if (raw.length < 4) return null;
    const charEnd = Number(raw[raw.length - 1]);
    const charStart = Number(raw[raw.length - 2]);
    const sceneId = raw.slice(1, raw.length - 2).join(":");
    if (!Number.isFinite(charStart) || !Number.isFinite(charEnd)) return null;
    const score = Number(item.badge?.label ?? "0") || 0;
    try {
      return await fetchSemanticPreview({
        sceneId,
        charStart,
        charEnd,
        score,
      });
    } catch {
      return null;
    }
  }
  // Lexical: subtitle に excerpt が入っている
  return buildLexicalPreview(item.title, item.subtitle ?? "");
}

function PreviewBody({ content }: { content: PreviewContent }) {
  if (content.kind === "lexical") {
    return (
      <div className="space-y-2">
        <div className="text-sm font-medium text-foreground">
          {content.title}
        </div>
        <div className="whitespace-pre-wrap text-muted-foreground">
          {content.excerpt}
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium text-foreground">
          {content.sceneTitle}
        </span>
        <span className="text-[10px] text-muted-foreground">
          {content.score.toFixed(2)}
        </span>
      </div>
      <div className="whitespace-pre-wrap leading-relaxed">
        <span className="text-muted-foreground">{content.before}</span>
        <span className="bg-accent/40 text-foreground">{content.chunk}</span>
        <span className="text-muted-foreground">{content.after}</span>
      </div>
    </div>
  );
}
