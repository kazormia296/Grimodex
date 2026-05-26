import type { PromptLang } from "./shared/types";
import { JA_CHAT_SYSTEM } from "./ja/chatSystem";
import { JA_AGENT_CONTROL } from "./ja/agentControl";
import { buildSummarizationPromptJa } from "./ja/summarization";
import { buildSummarizationPromptEn } from "./en/summarization";
import { buildBeatSystemPromptJa, buildBeatUserPromptJa } from "./ja/beat";
import { buildMentionRolesPromptJa } from "./ja/inferMentionRoles";
import {
  buildInlineAiSystemPromptJa,
  buildInlineAiUserPromptJa,
} from "./ja/inlineAi";
import {
  buildGenerateBeatsMessagesJa,
  buildGenerateSynopsisMessagesJa,
} from "./ja/beatGenerate";
import {
  buildProposePastSetupsPromptJa,
  buildEvaluateSetupStrengthPromptJa,
  buildAuditChapterPromptJa,
} from "./ja/foreshadow";
import {
  buildSynopsisFromContentPromptJa,
  buildSessionTitlePromptJa,
} from "./ja/chatApi";
import { JA_POST_EFFECT } from "./ja/postEffect";

const JA_CATALOG = {
  chatSystem: JA_CHAT_SYSTEM,
  agentControl: JA_AGENT_CONTROL,
  summarization: {
    buildPrompt: buildSummarizationPromptJa,
  },
  beat: {
    buildSystemPrompt: buildBeatSystemPromptJa,
    buildUserPrompt: buildBeatUserPromptJa,
  },
  inferMentionRoles: {
    buildPrompt: buildMentionRolesPromptJa,
  },
  inlineAi: {
    buildSystemPrompt: buildInlineAiSystemPromptJa,
    buildUserPrompt: buildInlineAiUserPromptJa,
  },
  beatGenerate: {
    buildGenerateBeatsMessages: buildGenerateBeatsMessagesJa,
    buildGenerateSynopsisMessages: buildGenerateSynopsisMessagesJa,
  },
  foreshadow: {
    buildProposePastSetupsPrompt: buildProposePastSetupsPromptJa,
    buildEvaluateSetupStrengthPrompt: buildEvaluateSetupStrengthPromptJa,
    buildAuditChapterPrompt: buildAuditChapterPromptJa,
  },
  chatApi: {
    buildSynopsisFromContentPrompt: buildSynopsisFromContentPromptJa,
    buildSessionTitlePrompt: buildSessionTitlePromptJa,
  },
  postEffect: JA_POST_EFFECT,
};

export type PromptCatalog = typeof JA_CATALOG;

const _warned = new Set<string>();

export function getPromptCatalog(lang: PromptLang | string): PromptCatalog {
  if (lang === "ja") return JA_CATALOG;
  if (lang === "en") {
    return {
      ...JA_CATALOG,
      summarization: { buildPrompt: buildSummarizationPromptEn },
    };
  }
  if (!_warned.has(lang)) {
    console.warn(`[prompts] no catalog for lang="${lang}", falling back to ja`);
    _warned.add(lang);
  }
  return JA_CATALOG;
}
