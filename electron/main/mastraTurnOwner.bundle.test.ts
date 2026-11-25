import path from "node:path";
import { pathToFileURL } from "node:url";

import esbuild from "esbuild";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const forbiddenKind = (reference: string): string | null => {
  if (reference.includes("readDomain/core/")) return "readDomain/core";
  if (reference.includes("drizzle-orm")) return "drizzle-orm";
  if (reference.includes("temporal-polyfill")) return "temporal-polyfill";
  if (reference.includes("mastraTurnReadBindings"))
    return "mastraTurnReadBindings";
  return null;
};

describe("main's static import closure", () => {
  it("keeps read tool execution dependencies behind the dynamic loader", async () => {
    const build = (await import(
      pathToFileURL(path.join(repoRoot, "electron", "scripts", "build.mjs"))
        .href
    )) as { bundleConfigs: esbuild.BuildOptions[] };
    const config = build.bundleConfigs[0]!;
    const result = await esbuild.build({
      ...config,
      write: false,
      metafile: true,
      logLevel: "silent",
    });
    const inputs = result.metafile!.inputs;
    const entry = Object.keys(inputs).find(
      (input) =>
        path.resolve(repoRoot, input) ===
        path.join(repoRoot, "electron", "main", "index.ts"),
    );
    expect(entry).toBeDefined();

    const parents = new Map<string, string | null>([[entry!, null]]);
    const pending = [entry!];
    const violations = new Map<string, string>();
    const routeTo = (input: string): string[] => {
      const route = [input];
      let parent = parents.get(input);
      while (parent !== null && parent !== undefined) {
        route.unshift(parent);
        parent = parents.get(parent);
      }
      return route;
    };

    while (pending.length > 0) {
      const input = pending.pop()!;
      const inputKind = forbiddenKind(input);
      if (inputKind !== null && !violations.has(inputKind)) {
        violations.set(inputKind, routeTo(input).join(" -> "));
      }
      for (const imported of inputs[input]!.imports) {
        if (imported.kind === "dynamic-import") continue;
        const importedKind = forbiddenKind(imported.path);
        if (importedKind !== null && !violations.has(importedKind)) {
          violations.set(
            importedKind,
            `${routeTo(input).join(" -> ")} -> ${imported.path}`,
          );
        }
        if (inputs[imported.path] && !parents.has(imported.path)) {
          parents.set(imported.path, input);
          pending.push(imported.path);
        }
      }
    }

    // A walk that never left the entry would find nothing and pass vacuously.
    expect(
      [...parents.keys()].map((input) => path.resolve(repoRoot, input)),
    ).toContain(path.join(repoRoot, "electron", "main", "mastraTurnOwner.ts"));
    expect(Object.fromEntries(violations)).toEqual({});
  }, 120_000);
});
