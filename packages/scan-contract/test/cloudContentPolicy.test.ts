import { describe, expect, it } from "vitest";
import {
  CLOUDFLARE_ABUSE_POLICY_URL,
  CLOUDFLARE_ABUSE_REPORT_URL,
  CLOUDFLARE_WORKERS_AI_DATA_POLICY_URL,
  CLOUD_CONTENT_POLICY_VERSION,
  cloudContentPolicy,
} from "../src/cloudContentPolicy.js";

describe("cloud content policy", () => {
  it.each(["ja", "en"] as const)(
    "ships a complete %s rights and prohibited-content notice",
    (locale) => {
      const policy = cloudContentPolicy(locale);

      expect(CLOUD_CONTENT_POLICY_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
      expect(policy.heading.length).toBeGreaterThan(0);
      expect(policy.adultContentNotice).toMatch(
        locale === "ja" ? /成人向け・R18.*一律.*禁止/u : /adult.*R18.*not categorically prohibited/i,
      );
      expect(policy.adultContentNotice).toMatch(
        locale === "ja" ? /保証.*ません/u : /does not guarantee/i,
      );
      expect(policy.aiRefusalNotice).toMatch(
        locale === "ja" ? /AI.*拒否/u : /AI.*refuse/i,
      );
      expect(policy.rightsNotice).toMatch(
        locale === "ja" ? /権利.*許諾.*二次創作/u : /rights or permission.*derivative-work/i,
      );
      expect(policy.prohibitedItems).toHaveLength(4);
      expect(policy.prohibitedItems.join(" ")).toMatch(
        locale === "ja" ? /児童.*未成年/u : /children.*minors/i,
      );
      expect(policy.prohibitedItems.join(" ")).toMatch(
        locale === "ja" ? /人身取引/u : /human trafficking/i,
      );
      expect(policy.prohibitedItems.join(" ")).toMatch(
        locale === "ja" ? /著作権/u : /copyright/i,
      );
      expect(policy.prohibitedItems.join(" ")).toMatch(
        locale === "ja" ? /個人情報/u : /personal data/i,
      );
      expect(policy.confirmation).toMatch(
        locale === "ja" ? /必要な権利・許諾/u : /required rights or permission/i,
      );
    },
  );

  it("uses named current Cloudflare policy destinations", () => {
    expect(CLOUDFLARE_ABUSE_POLICY_URL).toBe(
      "https://blog.cloudflare.com/cloudflares-abuse-policies-and-approach/",
    );
    expect(CLOUDFLARE_WORKERS_AI_DATA_POLICY_URL).toBe(
      "https://developers.cloudflare.com/workers-ai/platform/data-usage/",
    );
    expect(CLOUDFLARE_ABUSE_REPORT_URL).toBe("https://abuse.cloudflare.com/");
  });
});
