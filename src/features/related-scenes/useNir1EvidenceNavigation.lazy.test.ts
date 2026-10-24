import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// C-6 (§9, DR-CP3B-10): the startup hook reaches the matching only through a
// dynamic import, and the lazy module imports no startup module statically.
const read = (name: string) =>
  readFileSync(path.join(import.meta.dirname, name), "utf8");
const staticImports = (source: string) =>
  [...source.matchAll(/^import\s+(type\s+)?[^;]*?from\s+"([^"]+)";/gms)].map(
    (match) => ({ typeOnly: Boolean(match[1]), from: match[2] }),
  );

describe("the Evidence consumer stays out of the startup JS graph", () => {
  it("the startup hook does not statically import the consume module", () => {
    const hook = read("useNir1EvidenceNavigation.ts");
    expect(
      staticImports(hook).filter(
        (item) =>
          item.from.includes("nir1EvidenceConsume") ||
          item.from.includes("nir1EvidenceRange") ||
          item.from.includes("nir1GraphApi"),
      ),
    ).toEqual([]);
    expect(hook).toContain('import("./nir1EvidenceConsume")');
  });

  it("the consume module imports the startup modules only as types", () => {
    const consume = read("nir1EvidenceConsume.ts");
    const runtime = staticImports(consume)
      .filter((item) => !item.typeOnly)
      .map((item) => item.from);
    expect(runtime.sort()).toEqual(
      [
        "./nir1EvidenceRange",
        "@/features/narrative-semantic-core/nir1GraphApi",
      ].sort(),
    );
  });
});
