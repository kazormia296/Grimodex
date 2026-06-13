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

  it("postEffect intentionally stays Japanese (kouetsu is a separate phase)", () => {
    // The kouetsu views hardcode getPromptCatalog("ja").postEffect, so the en
    // catalog deliberately keeps the ja postEffect to stay consistent until the
    // LLM-proofreading phase wires en there.
    expect(en.postEffect).toBe(JA_POST_EFFECT);
  });
});
