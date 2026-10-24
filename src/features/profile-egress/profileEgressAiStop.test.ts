import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import i18n from "@/lib/i18n";
import { classifyError } from "@/application/chat/chatStoreSupport";
import {
  PROFILE_ACTIVATION_STOPPED_MESSAGE,
  profileActivationStopAuditMetadata,
} from "@/features/ai-audit/transportContext";
import { aiFailureText } from "./profileEgressAiStop";
import * as text from "./profileEgressAiStopText";

const repo = resolve(__dirname, "../../..");
const read = (path: string) => readFileSync(resolve(repo, path), "utf8");

// The texts the renderer recognizes, as Main and Native write them.
const SYNTHESIZED = PROFILE_ACTIVATION_STOPPED_MESSAGE;
const LEGACY_STOPPED =
  "D2A_EGRESS_DENIED: legacy-request-stopped: the provider request was stopped by the profile restriction";
const DISCARDED_EXTERNAL =
  "D2A_EGRESS_DENIED: old-external-ai: route send_chat_message completed after profile restriction began";
const DISCARDED_LOCAL =
  "D2A_EGRESS_DENIED: old-local-ai: route send_agent_message completed after profile restriction began";

beforeEach(async () => {
  await i18n.changeLanguage("ja");
});

describe("the profile activation's AI terminals (D-10 (a), DR-DA2-34)", () => {
  it("matches the texts Main and Native write", () => {
    expect(SYNTHESIZED).toBe("D2A_EGRESS_DENIED: profile-activation-stopped");
    expect(read("electron/main/profileEgress.ts")).toContain(
      "PROFILE_ACTIVATION_STOPPED_MESSAGE = `${D2A_EGRESS_DENIED_MARKER} profile-activation-stopped`",
    );
    expect(read("electron/main/profileEgress.ts")).toContain(
      "`route ${command} completed after profile restriction began`",
    );
    // Native's stage-5 text is not read from here (the renderer does not
    // reference the Native module's sources); the pattern only needs its
    // `legacy-request-stopped` code, which `d2aActivation.pipeline.spec.ts`
    // pins on the real Native.
    expect(read("electron/main/profileEgress.ts")).toContain(
      'export const D2A_EGRESS_DENIED_MARKER = "D2A_EGRESS_DENIED:";',
    );
  });

  // Runs before any test registers the strings (the file's module state).
  it("answers null until the chat panel's strings are registered", () => {
    expect(i18n.exists("profileEgressAiStop.stopped")).toBe(false);
    expect(aiFailureText(SYNTHESIZED)).toBeNull();
    text.ensureProfileEgressAiStopTranslations();
    expect(aiFailureText(SYNTHESIZED)).toBe(
      text.PROFILE_EGRESS_AI_STOP_TRANSLATIONS.ja.stopped,
    );
  });

  it("maps each terminal to its reason in both languages, and nothing else", async () => {
    text.ensureProfileEgressAiStopTranslations();
    const ja = text.PROFILE_EGRESS_AI_STOP_TRANSLATIONS.ja;
    expect(aiFailureText(SYNTHESIZED)).toBe(ja.stopped);
    expect(aiFailureText(LEGACY_STOPPED)).toBe(ja.stopped);
    expect(aiFailureText(`Error: ${LEGACY_STOPPED}`)).toBe(ja.stopped);
    expect(aiFailureText(DISCARDED_EXTERNAL)).toBe(ja.discarded);
    expect(aiFailureText(DISCARDED_LOCAL)).toBe(ja.discarded);
    await i18n.changeLanguage("en");
    expect(aiFailureText(SYNTHESIZED)).toBe(
      text.PROFILE_EGRESS_AI_STOP_TRANSLATIONS.en.stopped,
    );
    for (const other of [null, "", "provider failed"]) {
      expect(aiFailureText(other)).toBeNull();
    }
    // Any other refusal of the gate shows the generic error text, never the
    // raw marker (DA-2b, Negative (11); DR-DA2B-R5).
    for (const refusal of [
      "D2A_EGRESS_DENIED: old-external-ai: route send_chat_message is closed while restricted",
      "D2A_EGRESS_DENIED: plaintext-publication: route x completed after profile restriction began",
      "D2A_EGRESS_DENIED: profile-activation-stopped-later",
      "Error: D2A_EGRESS_DENIED: old-local-ai: route list_ai_models is closed while restricted",
      "db_execute rejected: D2A_EGRESS_DENIED: plaintext-publication: route db_execute is unavailable in profile local-only mode",
    ]) {
      expect(aiFailureText(refusal)).toBe(i18n.t("common.error"));
      expect(aiFailureText(refusal)).not.toContain("D2A_EGRESS_DENIED");
    }
  });

  it("changes neither the display nor the audit for a provider error that merely contains a marker (S4)", () => {
    text.ensureProfileEgressAiStopTranslations();
    for (const contained of [
      `provider said: ${SYNTHESIZED}`,
      `${SYNTHESIZED}.`,
      `${SYNTHESIZED}\nmore`,
      // The synthesized terminal is exact, as the audit requires.
      `Error: ${SYNTHESIZED}`,
      `upstream: ${LEGACY_STOPPED}`,
      `Error: upstream ${LEGACY_STOPPED}`,
      `ERROR: ${LEGACY_STOPPED}`,
      `provider: ${DISCARDED_EXTERNAL}`,
      `${DISCARDED_LOCAL} (retry)`,
      `Error: Error: ${DISCARDED_EXTERNAL}`,
    ]) {
      // Never the stop reason. A text that starts with the gate's marker is a
      // refusal and shows the generic error (DA-2b, DR-DA2B-R5); a provider
      // text that merely contains it keeps its own text.
      expect(aiFailureText(contained)).toBe(
        /^(?:Error: )?D2A_EGRESS_DENIED: [a-z0-9-]+(?::|$)/.test(contained)
          ? i18n.t("common.error")
          : null,
      );
      expect(profileActivationStopAuditMetadata(contained)).toBeNull();
    }
    // The audit marks the synthesized text only; the display accepts the
    // stringified prefix of the other two.
    expect(profileActivationStopAuditMetadata(SYNTHESIZED)).not.toBeNull();
    expect(aiFailureText(`Error: ${DISCARDED_EXTERNAL}`)).toBe(
      text.PROFILE_EGRESS_AI_STOP_TRANSLATIONS.ja.discarded,
    );
    // An anchored refusal that is not a stop terminal is the generic error,
    // not the stop reason.
    expect(
      aiFailureText("D2A_EGRESS_DENIED: legacy-request-stopped-later"),
    ).toBe(i18n.t("common.error"));
    expect(
      profileActivationStopAuditMetadata(
        "D2A_EGRESS_DENIED: legacy-request-stopped-later",
      ),
    ).toBeNull();
    expect(aiFailureText("D2A_EGRESS_DENIED: legacy-request-stopped")).toBe(
      text.PROFILE_EGRESS_AI_STOP_TRANSLATIONS.ja.stopped,
    );
  });

  it("keeps the chat's error classification for every terminal (no misattribution)", () => {
    for (const message of [
      SYNTHESIZED,
      LEGACY_STOPPED,
      DISCARDED_EXTERNAL,
      DISCARDED_LOCAL,
    ]) {
      expect(classifyError(new Error(message))).toBe("unknown");
    }
  });
});
