import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const extractionDir = dirname(fileURLToPath(import.meta.url));

describe("narrative validator ownership boundaries", () => {
  it("keeps Codex compilers free of strategy and signal imports", () => {
    for (const file of [
      "compiler.ts",
      "detailCompiler.ts",
      "phaseCompiler.ts",
    ]) {
      const source = readFileSync(join(extractionDir, file), "utf8");
      expect(source, file).not.toMatch(
        /from ["']\.\/relation(?:Strategy|Signals)["']/,
      );
      expect(source, file).not.toMatch(/relationSynthesis/);
    }
  });

  it("keeps the split modules free of persistence and writer imports", () => {
    for (const file of [
      "relationInvariant.ts",
      "relationStrategy.ts",
      "relationSignals.ts",
    ]) {
      const source = readFileSync(join(extractionDir, file), "utf8");
      expect(source, file).not.toMatch(/@\/db\//);
      expect(source, file).not.toMatch(/nativeApi|TypedWriter|PreparedPlan/);
    }
  });
});
