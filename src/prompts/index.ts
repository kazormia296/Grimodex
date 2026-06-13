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
import { EN_CHAT_SYSTEM } from "./en/chatSystem";
import { EN_AGENT_CONTROL } from "./en/agentControl";
import { buildBeatSystemPromptEn, buildBeatUserPromptEn } from "./en/beat";
import { buildMentionRolesPromptEn } from "./en/inferMentionRoles";
import {
  buildInlineAiSystemPromptEn,
  buildInlineAiUserPromptEn,
} from "./en/inlineAi";
import {
  buildGenerateBeatsMessagesEn,
  buildGenerateSynopsisMessagesEn,
} from "./en/beatGenerate";
import {
  buildProposePastSetupsPromptEn,
  buildEvaluateSetupStrengthPromptEn,
  buildAuditChapterPromptEn,
} from "./en/foreshadow";
import {
  buildSynopsisFromContentPromptEn,
  buildSessionTitlePromptEn,
} from "./en/chatApi";

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

// 完全な英語カタログ。チャット/Beat/インライン AI/伏線/chatApi/agentControl を
// 英語版に差し替える。postEffect (校閲) は別フェーズ対応のため JA のまま据え置く
// (kouetsu views も getPromptCatalog("ja") 固定なので整合)。
const EN_CATALOG: PromptCatalog = {
  chatSystem: EN_CHAT_SYSTEM,
  agentControl: EN_AGENT_CONTROL,
  summarization: {
    buildPrompt: buildSummarizationPromptEn,
  },
  beat: {
    buildSystemPrompt: buildBeatSystemPromptEn,
    buildUserPrompt: buildBeatUserPromptEn,
  },
  inferMentionRoles: {
    buildPrompt: buildMentionRolesPromptEn,
  },
  inlineAi: {
    buildSystemPrompt: buildInlineAiSystemPromptEn,
    buildUserPrompt: buildInlineAiUserPromptEn,
  },
  beatGenerate: {
    buildGenerateBeatsMessages: buildGenerateBeatsMessagesEn,
    buildGenerateSynopsisMessages: buildGenerateSynopsisMessagesEn,
  },
  foreshadow: {
    buildProposePastSetupsPrompt: buildProposePastSetupsPromptEn,
    buildEvaluateSetupStrengthPrompt: buildEvaluateSetupStrengthPromptEn,
    buildAuditChapterPrompt: buildAuditChapterPromptEn,
  },
  chatApi: {
    buildSynopsisFromContentPrompt: buildSynopsisFromContentPromptEn,
    buildSessionTitlePrompt: buildSessionTitlePromptEn,
  },
  postEffect: JA_POST_EFFECT,
};

const _warned = new Set<string>();

export function getPromptCatalog(lang: PromptLang | string): PromptCatalog {
  if (lang === "ja") return JA_CATALOG;
  if (lang === "en") return EN_CATALOG;
  if (!_warned.has(lang)) {
    console.warn(`[prompts] no catalog for lang="${lang}", falling back to ja`);
    _warned.add(lang);
  }
  return JA_CATALOG;
}
