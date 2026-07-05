import { describe, it, expect } from "vitest";
import { getPromptCatalog } from "./index";
import { EN_CHAT_SYSTEM } from "./en/chatSystem";
import { EN_AGENT_CONTROL } from "./en/agentControl";
import { buildBeatSystemPromptEn } from "./en/beat";
import { buildInlineAiSystemPromptEn } from "./en/inlineAi";
import { buildMentionRolesPromptEn } from "./en/inferMentionRoles";
import { buildSynopsisFromContentPromptEn } from "./en/chatApi";
import { buildProposePastSetupsPromptEn } from "./en/foreshadow";
import { buildGenerateBeatsMessagesEn } from "./en/beatGenerate";
import { buildSummarizationPromptEn } from "./en/summarization";
import { JA_CHAT_SYSTEM } from "./ja/chatSystem";
import { JA_POST_EFFECT } from "./ja/postEffect";
import { EN_POST_EFFECT } from "./en/postEffect";
import { KOUETSU_JSON_DELIMITER } from "@/features/post-effect/customInstruction";

describe("getPromptCatalog en wiring", () => {
  const en = getPromptCatalog("en");

  it("chat-facing prompts resolve to the English versions (not ja fallback)", () => {
    expect(en.chatSystem).toBe(EN_CHAT_SYSTEM);
    expect(en.agentControl).toBe(EN_AGENT_CONTROL);
    expect(en.beat.buildSystemPrompt).toBe(buildBeatSystemPromptEn);
    expect(en.inlineAi.buildSystemPrompt).toBe(buildInlineAiSystemPromptEn);
    expect(en.inferMentionRoles.buildPrompt).toBe(buildMentionRolesPromptEn);
    expect(en.chatApi.buildSynopsisFromContentPrompt).toBe(
      buildSynopsisFromContentPromptEn,
    );
    expect(en.foreshadow.buildProposePastSetupsPrompt).toBe(
      buildProposePastSetupsPromptEn,
    );
    expect(en.beatGenerate.buildGenerateBeatsMessages).toBe(
      buildGenerateBeatsMessagesEn,
    );
    expect(en.summarization.buildPrompt).toBe(buildSummarizationPromptEn);
  });

  it("ja catalog stays Japanese", () => {
    const ja = getPromptCatalog("ja");
    expect(ja.chatSystem).toBe(JA_CHAT_SYSTEM);
    expect(ja.chatSystem.headers.projectInfo).toContain("プロジェクト情報");
  });

  it("en chatSystem is English (headers/typeLabels), distinct from ja", () => {
    expect(en.chatSystem.headers.projectInfo).toContain("Project Information");
    expect(en.chatSystem.headers.projectInfo).not.toBe(
      JA_CHAT_SYSTEM.headers.projectInfo,
    );
    expect(en.chatSystem.typeLabels.character).toBe("Character");
  });

  it("en L1 trim markers match how contextBuilder assembles the en L1 block", () => {
    // contextBuilder builds L1 as `${headers.projectInfo}\n${labels.title}: ...`
    // with the style guide as `${labels.styleGuide}:\n<value>`. The en L1 removable
    // patterns must match that en text or trimming silently no-ops for en projects.
    const h = en.chatSystem.headers;
    const l = en.chatSystem.labels;
    const l1Block =
      `${h.projectInfo}\n${l.title}: T\n${l.genre}: Fantasy\n` +
      `${l.styleGuide}:\nbe concise and vivid`;
    const matched = en.chatSystem.trimMarkers.l1.removablePatterns.some((re) =>
      re.test(l1Block),
    );
    expect(matched, "an en L1 pattern should match the style-guide block").toBe(
      true,
    );
  });

  it("en L3 body-header regex matches the en scene-body header", () => {
    const sceneBlock = `prefix${en.chatSystem.headers.sceneBody}\nthe body`;
    expect(en.chatSystem.trimMarkers.l3.bodyHeaderRegex.test(sceneBlock)).toBe(
      true,
    );
  });

  it("postEffect resolves per language (en gets the English kouetsu prompts)", () => {
    // The kouetsu views now call getPromptCatalog(lang).postEffect, so the en
    // catalog must expose the English postEffect set while ja stays Japanese.
    // EN_POST_EFFECT is a *separate* object from JA_POST_EFFECT so ja annotation
    // caches (input_hash is project-scoped and does not see the prompt body)
    // stay valid — never collapse these back to one shared object.
    expect(en.postEffect).toBe(EN_POST_EFFECT);
    expect(getPromptCatalog("ja").postEffect).toBe(JA_POST_EFFECT);
    expect(en.postEffect).not.toBe(JA_POST_EFFECT);
  });

  it("every en postEffect prompt contains the JSON delimiter verbatim", () => {
    // appendKouetsuGuidance / appendIntentGuidance / appendStoryContextGuidance /
    // appendTimelineGuidance all splice at KOUETSU_JSON_DELIMITER via indexOf.
    // If an en prompt drifts from the exact delimiter string they silently no-op
    // (guidance/context is dropped), so pin its presence in all 8 keys.
    const keys = [
      "consistencySystem",
      "typoSystem",
      "intraSystem",
      "reviewSystem",
      "intentDriftSystem",
      "timelineConsistencySystem",
      "pseudoCommentSystem",
      "metaStructureSystem",
    ] as const;
    for (const key of keys) {
      const prompt = EN_POST_EFFECT[key];
      const occurrences = prompt.split(KOUETSU_JSON_DELIMITER).length - 1;
      expect(occurrences, `${key} must contain the JSON delimiter once`).toBe(
        1,
      );
    }
  });

  it("consistency/typo/intra prompts pin the explicit empty-array instruction (ja/en)", () => {
    // 弱いローカル LLM は「該当なし」を {} やキー省略で返しがちで、期待キー
    // 欠落 → scene 失敗 → プロジェクト全体チェック失敗の一因だった。
    // 「空配列を返せ」の指示行を ja/en 両方で固定する (落とすと再発する)。
    expect(JA_POST_EFFECT.consistencySystem).toContain('"violations" を空配列');
    expect(JA_POST_EFFECT.typoSystem).toContain('"issues" を空配列');
    expect(JA_POST_EFFECT.intraSystem).toContain('"pairs" を空配列');
    expect(EN_POST_EFFECT.consistencySystem).toContain(
      'empty "violations" array',
    );
    expect(EN_POST_EFFECT.typoSystem).toContain('empty "issues" array');
    expect(EN_POST_EFFECT.intraSystem).toContain('empty "pairs" array');
  });
});
