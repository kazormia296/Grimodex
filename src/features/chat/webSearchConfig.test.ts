import { describe, it, expect } from "vitest";
import {
  parseWebSearchControls,
  buildWebSearchConfig,
  normalizeDomain,
  normalizeDomainList,
} from "./webSearchConfig";

describe("normalizeDomain / normalizeDomainList", () => {
  it("trims, strips scheme and trailing slash, preserves subpaths", () => {
    expect(normalizeDomain("  https://Example.com/ ")).toBe("Example.com");
    expect(normalizeDomain("http://bar.net/blog/")).toBe("bar.net/blog");
    expect(normalizeDomain("docs.example.com")).toBe("docs.example.com");
  });

  it("drops empties and dedupes a list", () => {
    expect(
      normalizeDomainList(["a.com", "https://a.com/", "  ", "b.org"]),
    ).toEqual(["a.com", "b.org"]);
  });
});

describe("parseWebSearchControls", () => {
  it("defaults to off / empty / undefined for blank input", () => {
    const c = parseWebSearchControls({});
    expect(c.domainMode).toBe("off");
    expect(c.domains).toEqual([]);
    expect(c.maxContentTokens).toBeUndefined();
  });

  it("keeps allow / block modes and coerces unknown to off", () => {
    expect(parseWebSearchControls({ domainMode: "allow" }).domainMode).toBe(
      "allow",
    );
    expect(parseWebSearchControls({ domainMode: "block" }).domainMode).toBe(
      "block",
    );
    expect(parseWebSearchControls({ domainMode: "bogus" }).domainMode).toBe(
      "off",
    );
  });

  it("parses a JSON array, trims, strips scheme/trailing slash, drops empties, dedupes", () => {
    const c = parseWebSearchControls({
      domainsJson: JSON.stringify([
        "  example.com ",
        "https://Foo.org/",
        "example.com",
        "",
        "   ",
        "http://bar.net/blog",
      ]),
    });
    expect(c.domains).toEqual(["example.com", "Foo.org", "bar.net/blog"]);
  });

  it("falls back to [] on invalid JSON or non-array", () => {
    expect(parseWebSearchControls({ domainsJson: "not json" }).domains).toEqual(
      [],
    );
    expect(parseWebSearchControls({ domainsJson: '{"a":1}' }).domains).toEqual(
      [],
    );
  });

  it("parses a positive integer maxContentTokens and ignores non-positive / NaN", () => {
    expect(
      parseWebSearchControls({ maxContentTokensRaw: "4000" }).maxContentTokens,
    ).toBe(4000);
    expect(
      parseWebSearchControls({ maxContentTokensRaw: "1500.9" })
        .maxContentTokens,
    ).toBe(1500);
    expect(
      parseWebSearchControls({ maxContentTokensRaw: "0" }).maxContentTokens,
    ).toBeUndefined();
    expect(
      parseWebSearchControls({ maxContentTokensRaw: "-5" }).maxContentTokens,
    ).toBeUndefined();
    expect(
      parseWebSearchControls({ maxContentTokensRaw: "" }).maxContentTokens,
    ).toBeUndefined();
    expect(
      parseWebSearchControls({ maxContentTokensRaw: "abc" }).maxContentTokens,
    ).toBeUndefined();
  });
});

describe("buildWebSearchConfig", () => {
  const offControls = { domainMode: "off" as const, domains: [] };

  it("returns null when RAG is not active", () => {
    expect(buildWebSearchConfig(false, false, offControls)).toBeNull();
    expect(
      buildWebSearchConfig(false, true, {
        domainMode: "allow",
        domains: ["example.com"],
        maxContentTokens: 4000,
      }),
    ).toBeNull();
  });

  it("returns the Phase 1 base config with no Phase 2 fields when controls are off", () => {
    const cfg = buildWebSearchConfig(true, false, offControls);
    expect(cfg).toEqual({
      enabled: true,
      agentic: false,
      maxResults: 5,
      maxUses: 3,
    });
    expect(cfg?.allowedDomains).toBeUndefined();
    expect(cfg?.blockedDomains).toBeUndefined();
    expect(cfg?.maxContentTokens).toBeUndefined();
  });

  it("passes the agentic flag through", () => {
    expect(buildWebSearchConfig(true, true, offControls)?.agentic).toBe(true);
    expect(buildWebSearchConfig(true, false, offControls)?.agentic).toBe(false);
  });

  it("sets allowedDomains (only) in allow mode", () => {
    const cfg = buildWebSearchConfig(true, false, {
      domainMode: "allow",
      domains: ["example.com", "trusted.org"],
    });
    expect(cfg?.allowedDomains).toEqual(["example.com", "trusted.org"]);
    expect(cfg?.blockedDomains).toBeUndefined();
  });

  it("sets blockedDomains (only) in block mode", () => {
    const cfg = buildWebSearchConfig(true, false, {
      domainMode: "block",
      domains: ["spam.example"],
    });
    expect(cfg?.blockedDomains).toEqual(["spam.example"]);
    expect(cfg?.allowedDomains).toBeUndefined();
  });

  it("omits domain fields when the mode is set but the list is empty", () => {
    const cfg = buildWebSearchConfig(true, false, {
      domainMode: "allow",
      domains: [],
    });
    expect(cfg?.allowedDomains).toBeUndefined();
    expect(cfg?.blockedDomains).toBeUndefined();
  });

  it("includes maxContentTokens only when positive", () => {
    expect(
      buildWebSearchConfig(true, false, {
        ...offControls,
        maxContentTokens: 4000,
      })?.maxContentTokens,
    ).toBe(4000);
    expect(
      buildWebSearchConfig(true, false, {
        ...offControls,
        maxContentTokens: 0,
      })?.maxContentTokens,
    ).toBeUndefined();
  });
});
