import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// C-6 (§9, DR-CP3B-10): the startup hook reaches the matching only through a
// dynamic import, and the lazy module's own direct imports are the ones
// listed. Checked per file (direct imports only): what those modules import
// in turn is measured by the startup budget (DR-CP3B-11), not here.
const read = (name: string) =>
  readFileSync(path.join(import.meta.dirname, name), "utf8");
/** Every static `import … from`, `export … from` and side-effect `import "…"`. */
const staticImports = (source: string) =>
  [
    ...source.matchAll(
      /^\s*(?:(import|export)\s+(type\s+)?[^;]*?\bfrom\s+|import\s+)["']([^"']+)["']/gm,
    ),
  ].map((match) => ({ typeOnly: Boolean(match[2]), from: match[3] }));

describe("the Evidence consumer stays out of the startup JS graph", () => {
  it("the startup hook does not directly import (or re-export) the consume module", () => {
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

  it("the consume module's direct runtime imports are only the range module and the Graph qualify wrapper", () => {
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

  it("the import scan sees re-exports and side-effect imports", () => {
    expect(
      staticImports(
        [
          'import "./nir1EvidenceConsume";',
          'export { consume } from "./nir1EvidenceConsume";',
          'export * from "./nir1EvidenceRange";',
          "export type { Claim } from './nir1GraphApi';",
          'import type {\n  A,\n} from "./types";',
          'const lazy = () => import("./nir1EvidenceConsume");',
        ].join("\n"),
      ),
    ).toEqual([
      { typeOnly: false, from: "./nir1EvidenceConsume" },
      { typeOnly: false, from: "./nir1EvidenceConsume" },
      { typeOnly: false, from: "./nir1EvidenceRange" },
      { typeOnly: true, from: "./nir1GraphApi" },
      { typeOnly: true, from: "./types" },
    ]);
  });
});
