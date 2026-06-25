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
import { buildProposePlotThreadsPromptJa } from "./ja/plotThread";
import {
  buildSynopsisFromContentPromptJa,
  buildSessionTitlePromptJa,
} from "./ja/chatApi";
import { JA_POST_EFFECT } from "./ja/postEffect";
import { buildCandidateJudgmentPromptJa } from "./ja/codexJudgment";
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
import { buildProposePlotThreadsPromptEn } from "./en/plotThread";
import { buildCandidateJudgmentPromptEn } from "./en/codexJudgment";
import {
  buildSynopsisFromContentPromptEn,
  buildSessionTitlePromptEn,
} from "./en/chatApi";
import { EN_POST_EFFECT } from "./en/postEffect";

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
  plotThread: {
    buildProposePlotThreadsPrompt: buildProposePlotThreadsPromptJa,
  },
  chatApi: {
    buildSynopsisFromContentPrompt: buildSynopsisFromContentPromptJa,
    buildSessionTitlePrompt: buildSessionTitlePromptJa,
  },
  codexJudgment: {
    buildCandidateJudgmentPrompt: buildCandidateJudgmentPromptJa,
  },
  // ja/en の postEffect は `as const` で互いに異なる文字列リテラル型になるため、
  // string 値へ widen してどちらの言語セットも代入可能にする (中身は不変)。
  postEffect: JA_POST_EFFECT as PostEffectPrompts,
};

/** postEffect の各 system prompt を string 値に widen した形 (ja/en 共通)。 */
export type PostEffectPrompts = { [K in keyof typeof JA_POST_EFFECT]: string };

export type PromptCatalog = typeof JA_CATALOG;

// 完全な英語カタログ。チャット/Beat/インライン AI/伏線/chatApi/agentControl/
// 校閲(postEffect) を英語版に差し替える。typo カテゴリは英語向け(spelling/
// grammar/punctuation)を ja の5種に union 済 (Rust allow-list / FE TypoCategory)。
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
  plotThread: {
    buildProposePlotThreadsPrompt: buildProposePlotThreadsPromptEn,
  },
  chatApi: {
    buildSynopsisFromContentPrompt: buildSynopsisFromContentPromptEn,
    buildSessionTitlePrompt: buildSessionTitlePromptEn,
  },
  codexJudgment: {
    buildCandidateJudgmentPrompt: buildCandidateJudgmentPromptEn,
  },
  postEffect: EN_POST_EFFECT,
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
