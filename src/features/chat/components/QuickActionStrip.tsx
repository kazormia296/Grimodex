import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Sparkles } from "lucide-react";
import { useChatStore } from "../chatStore";
import { useTreeStore } from "@/features/tree/treeStore";

interface QuickActionItem {
  /** i18n key for the chip label */
  labelKey: string;
  /** i18n key for the prompt text injected into ChatInput */
  promptKey: string;
}

const SCENE_ACTIONS: QuickActionItem[] = [
  {
    labelKey: "chat.quickActions.scene.polish",
    promptKey: "chat.quickActions.scene.polishPrompt",
  },
  {
    labelKey: "chat.quickActions.scene.expand",
    promptKey: "chat.quickActions.scene.expandPrompt",
  },
  {
    labelKey: "chat.quickActions.scene.dialogue",
    promptKey: "chat.quickActions.scene.dialoguePrompt",
  },
];

const FOLDER_CHAPTER_ACTIONS: QuickActionItem[] = [
  {
    labelKey: "chat.quickActions.folder.foreshadow",
    promptKey: "chat.quickActions.folder.foreshadowPrompt",
  },
  {
    labelKey: "chat.quickActions.folder.pacing",
    promptKey: "chat.quickActions.folder.pacingPrompt",
  },
  {
    labelKey: "chat.quickActions.folder.outline",
    promptKey: "chat.quickActions.folder.outlinePrompt",
  },
];

const FOLDER_ACT_ACTIONS: QuickActionItem[] = [
  {
    labelKey: "chat.quickActions.folder.arc",
    promptKey: "chat.quickActions.folder.arcPrompt",
  },
  {
    labelKey: "chat.quickActions.folder.turning",
    promptKey: "chat.quickActions.folder.turningPrompt",
  },
  {
    labelKey: "chat.quickActions.folder.foreshadow",
    promptKey: "chat.quickActions.folder.foreshadowPrompt",
  },
];

const PROJECT_ACTIONS: QuickActionItem[] = [
  {
    labelKey: "chat.quickActions.project.plot",
    promptKey: "chat.quickActions.project.plotPrompt",
  },
  {
    labelKey: "chat.quickActions.project.character",
    promptKey: "chat.quickActions.project.characterPrompt",
  },
  {
    labelKey: "chat.quickActions.project.next",
    promptKey: "chat.quickActions.project.nextPrompt",
  },
  {
    labelKey: "chat.quickActions.project.foreshadow",
    promptKey: "chat.quickActions.project.foreshadowPrompt",
  },
];

export function QuickActionStrip() {
  const { t } = useTranslation();
  const chatScope = useChatStore((s) => s.chatScope);
  const scopeAnchorId = useChatStore((s) => s.scopeAnchorId);
  const setPendingLookupText = useChatStore((s) => s.setPendingLookupText);
  const nodes = useTreeStore((s) => s.nodes);

  const actions = useMemo<QuickActionItem[]>(() => {
    if (chatScope === "scene") return SCENE_ACTIONS;
    if (chatScope === "project") return PROJECT_ACTIONS;
    // folder スコープ: 親なしの root folder = Act 系、それ以外 = Chapter 系
    const folder = nodes.find((n) => n.id === scopeAnchorId);
    const isAct = !!folder && folder.parentId === null;
    return isAct ? FOLDER_ACT_ACTIONS : FOLDER_CHAPTER_ACTIONS;
  }, [chatScope, scopeAnchorId, nodes]);

  if (actions.length === 0) return null;

  return (
    <div
      role="toolbar"
      aria-label={t("chat.quickActions.ariaLabel")}
      className="flex items-center gap-1.5 overflow-x-auto border-t border-border/60 bg-muted/30 px-3 py-1.5"
    >
      <Sparkles
        className="h-3 w-3 shrink-0 text-muted-foreground/70"
        aria-hidden="true"
      />
      {actions.map((a) => (
        <button
          key={a.labelKey}
          type="button"
          onClick={() => setPendingLookupText(t(a.promptKey))}
          className="shrink-0 rounded-full border border-border/60 bg-background px-2.5 py-0.5 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:bg-accent hover:text-foreground"
        >
          {t(a.labelKey)}
        </button>
      ))}
    </div>
  );
}
