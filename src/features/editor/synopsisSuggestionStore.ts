import { create } from "zustand";
import { toast } from "sonner";
import i18next from "i18next";
import {
  findTreeNodeSummary,
  updateTreeSynopsis,
} from "@/features/tree/treeProjection";
import { loadSceneContent } from "@/features/tree/api";
import { generateSynopsisFromContent } from "@/features/chat/chatApi";
import {
  blockIfPolicyOff,
  isAiFeatureBlockedByPolicy,
} from "@/features/ai-policy/policyGuard";
import { blockIfUnlicensed } from "@/features/license/gate";
import { prosemirrorToText } from "@/lib/prosemirror";

const TOAST_ID = "synopsis-suggestion";

interface SynopsisSuggestionState {
  pendingSceneId: string | null;
  /** Show a synopsis-empty suggestion for the given scene, replacing any
   *  prior pending suggestion (only one at a time per design). */
  propose: (sceneId: string) => void;
  /** User dismissed without acting. */
  dismiss: () => void;
  /** User accepted: run the AI generation. */
  generate: () => Promise<void>;
}

export const useSynopsisSuggestionStore = create<SynopsisSuggestionState>(
  (set, get) => ({
    pendingSceneId: null,
    propose(sceneId) {
      // Synopsis generation is on-demand AI body-write; when bodyWrite is off
      // don't even offer the prompt (silent — blockIfPolicyOff would toast on
      // every status transition). generate() keeps the hard gate as defense.
      if (isAiFeatureBlockedByPolicy("bodyWrite")) return;
      set({ pendingSceneId: sceneId });
      toast(i18next.t("editor.status.synopsisEmpty"), {
        id: TOAST_ID,
        description: i18next.t("editor.status.synopsisPrompt"),
        duration: 10000,
        action: {
          label: "Generate",
          onClick: () => void get().generate(),
        },
        cancel: {
          label: "Dismiss",
          onClick: () => get().dismiss(),
        },
      });
    },
    dismiss() {
      toast.dismiss(TOAST_ID);
      set({ pendingSceneId: null });
    },
    async generate() {
      if (blockIfPolicyOff("bodyWrite")) return;
      if (blockIfUnlicensed()) return;
      const id = get().pendingSceneId;
      if (!id) return;
      set({ pendingSceneId: null });
      toast.dismiss(TOAST_ID);
      const node = findTreeNodeSummary(id);
      if (!node) return;
      try {
        const rawContent = await loadSceneContent(id);
        const content = prosemirrorToText(rawContent);
        if (!content?.trim()) {
          toast.warning(i18next.t("editor.status.emptySceneWarning"));
          return;
        }
        const generated = await generateSynopsisFromContent(
          node.title,
          content,
        );
        await updateTreeSynopsis(id, generated.trim());
        toast.success(i18next.t("editor.status.synopsisGenerated"));
      } catch {
        toast.error(i18next.t("editor.status.synopsisGenerateFailed"));
      }
    },
  }),
);
