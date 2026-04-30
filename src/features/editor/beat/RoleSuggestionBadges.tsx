import { useRef, useState, useMemo } from "react";
import type { Editor } from "@tiptap/core";
import { useTranslation } from "react-i18next";
import { AnimatedDropdown } from "@/components/ui/animated-dropdown";
import { useRoleSuggestionsStore } from "./roleSuggestionsStore";
import { applyRoleSuggestion } from "./applyRoleSuggestion";

const MAX_VISIBLE = 3;

const ROLE_LABELS: Record<string, string> = {
  actor: "actor",
  target: "target",
  mentioned: "mentioned",
};

interface BadgeItemProps {
  editor: Editor;
  beatId: string;
  codexId: string;
  name: string;
  suggestedRole: string;
  confidence: number;
}

function BadgeItem({
  editor,
  beatId,
  codexId,
  name,
  suggestedRole,
  confidence,
}: BadgeItemProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const markStatus = useRoleSuggestionsStore((s) => s.markStatus);

  const handleAccept = () => {
    applyRoleSuggestion(
      editor,
      beatId,
      codexId,
      suggestedRole as import("@/features/codex/CodexMentionExtension").MentionRole,
    );
    markStatus(beatId, codexId, "accepted");
    setOpen(false);
  };

  const handleReject = () => {
    markStatus(beatId, codexId, "rejected");
    setOpen(false);
  };

  const pct = Math.round(confidence * 100);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        title={t("editor.beat.roleSuggestion.badgeTooltip", {
          name,
          role: ROLE_LABELS[suggestedRole] ?? suggestedRole,
          pct,
        })}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-0.5 rounded border border-amber-400/50 bg-amber-50 px-1 py-0.5 text-[10px] text-amber-800 hover:bg-amber-100 dark:border-amber-500/40 dark:bg-amber-900/20 dark:text-amber-300 dark:hover:bg-amber-900/30"
      >
        <span>↑{ROLE_LABELS[suggestedRole] ?? suggestedRole}:</span>
        <span className="font-medium">{name}</span>
      </button>
      <AnimatedDropdown
        open={open}
        onClose={() => setOpen(false)}
        containerRef={containerRef}
        className="absolute left-0 top-6 z-50 min-w-[200px] rounded-md border border-border bg-popover p-2 shadow-md"
      >
        <p className="mb-2 text-xs text-muted-foreground">
          {t("editor.beat.roleSuggestion.prompt", {
            name,
            role: ROLE_LABELS[suggestedRole] ?? suggestedRole,
          })}
          <span className="ml-1 opacity-60">({pct}%)</span>
        </p>
        <div className="flex gap-1">
          <button
            type="button"
            onClick={handleAccept}
            className="flex-1 rounded bg-primary px-2 py-1 text-[10px] text-primary-foreground hover:opacity-90"
          >
            {t("editor.beat.roleSuggestion.accept")}
          </button>
          <button
            type="button"
            onClick={handleReject}
            className="flex-1 rounded border border-border px-2 py-1 text-[10px] hover:bg-muted"
          >
            {t("editor.beat.roleSuggestion.reject")}
          </button>
        </div>
      </AnimatedDropdown>
    </div>
  );
}

interface RoleSuggestionBadgesProps {
  editor: Editor | null;
  beatId: string;
}

export function RoleSuggestionBadges({
  editor,
  beatId,
}: RoleSuggestionBadgesProps) {
  const entries = useRoleSuggestionsStore((s) => s.byBeatId[beatId]);
  const active = useMemo(
    () => (entries ?? []).filter((e) => e.status === "pending"),
    [entries],
  );

  if (!editor || active.length === 0) return null;

  const visible = active.slice(0, MAX_VISIBLE);
  const overflow = active.length - MAX_VISIBLE;

  return (
    <div className="flex items-center gap-1">
      {visible.map((s) => (
        <BadgeItem
          key={s.codexId}
          editor={editor}
          beatId={beatId}
          codexId={s.codexId}
          name={s.name}
          suggestedRole={s.suggestedRole}
          confidence={s.confidence}
        />
      ))}
      {overflow > 0 && (
        <span className="rounded border border-muted px-1 py-0.5 text-[10px] text-muted-foreground">
          +{overflow}
        </span>
      )}
    </div>
  );
}
