import i18next from "i18next";
import { beforeAll, describe, expect, it } from "vitest";
import en from "@/locales/en.json";
import ja from "@/locales/ja.json";
import {
  BLOCKED_REASON_DETAIL_UNMAPPED,
  BLOCKED_REASON_ENTRY_AMBIGUOUS,
  BLOCKED_REASON_EVIDENCE_UNRESOLVED,
  BLOCKED_REASON_PHASE_AMBIGUOUS,
  BLOCKED_REASON_RELATION_EXISTS,
  localizeBlockedReason,
} from "./blockedReasons";

const reasons = [
  [
    BLOCKED_REASON_EVIDENCE_UNRESOLVED,
    "codex.structureReview.blockedReason.evidenceUnresolved",
  ],
  [
    BLOCKED_REASON_RELATION_EXISTS,
    "codex.structureReview.blockedReason.relationExists",
  ],
  [
    BLOCKED_REASON_ENTRY_AMBIGUOUS,
    "codex.structureReview.blockedReason.entryAmbiguous",
  ],
  [
    BLOCKED_REASON_DETAIL_UNMAPPED,
    "codex.structureReview.blockedReason.detailUnmapped",
  ],
  [
    BLOCKED_REASON_PHASE_AMBIGUOUS,
    "codex.structureReview.blockedReason.phaseAmbiguous",
  ],
] as const;

describe("Codex structure review blocked reasons", () => {
  const i18n = i18next.createInstance();

  beforeAll(async () => {
    await i18n.init({
      lng: "ja",
      resources: { ja: { translation: ja }, en: { translation: en } },
      interpolation: { escapeValue: false },
    });
  });

  it("keeps the original Japanese reason strings", () => {
    expect(reasons.map(([reason]) => reason)).toEqual([
      "根拠が未解決です。再抽出して根拠を確認してください",
      "既に同じ関係が登録されています（適用不要）",
      "既存 Entry 候補が複数あり、Binding が未解決です",
      "Detail 定義が未割当です",
      "既存 Phase 候補が複数あります",
    ]);
  });

  it.each(reasons)(
    "localizes the stored reason in Japanese and English",
    async (reason, key) => {
      await i18n.changeLanguage("ja");
      expect(localizeBlockedReason(reason, i18n.t)).toBe(i18n.t(key));
      await i18n.changeLanguage("en");
      expect(localizeBlockedReason(reason, i18n.t)).toBe(i18n.t(key));
    },
  );

  it("preserves unknown and missing reasons", () => {
    expect(localizeBlockedReason("unknown reason", i18n.t)).toBe(
      "unknown reason",
    );
    expect(localizeBlockedReason(undefined, i18n.t)).toBeUndefined();
  });
});
