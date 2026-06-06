import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseAiPolicy } from "./parse";

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "policyDecisionVector.fixture.json",
);

interface FixtureCase {
  label: string;
  raw: string;
  expected: Record<string, boolean>;
}

describe("policyDecisionVector fixture (TS parity)", () => {
  const cases = JSON.parse(readFileSync(fixturePath, "utf8")) as FixtureCase[];

  for (const c of cases) {
    it(c.label, () => {
      const parsed = parseAiPolicy(c.raw);
      expect(parsed.toggles.chat).toBe(c.expected.chat);
      expect(parsed.toggles.bodyWrite).toBe(c.expected.bodyWrite);
      expect(parsed.toggles.analysis).toBe(c.expected.analysis);
      expect(parsed.toggles.structureWrite).toBe(c.expected.structureWrite);
      expect(parsed.toggles.knowledgeWrite).toBe(c.expected.knowledgeWrite);
    });
  }
});
