import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CHAT_AGENT_IR_ENABLED } from "./chatAgentIrAvailability";

/**
 * B-T6: the renderer's closure of the chat IR route (S1-B, DR-CHATIR-S1-29〜32).
 * The route has three closures: this constant, Main's gate and Native's gate.
 */

const repoRoot = path.resolve(__dirname, "..", "..", "..", "..");
const WRAPPER = "src/lib/chatIr.ts";
const CONSTANT_FILE = "src/features/chat/agent/chatAgentIrAvailability.ts";

function* productSources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "target" || name === "dist") {
      continue;
    }
    const full = path.join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) yield* productSources(full);
    else if (
      /\.(ts|tsx|mjs|js)$/u.test(name) &&
      !/\.(test|spec)\.(ts|tsx|mjs|js)$/u.test(name) &&
      !/\.(browser|live)\.test\./u.test(name) &&
      !name.endsWith(".d.ts") &&
      !/\.testSupport\./u.test(name)
    ) {
      yield full;
    }
  }
}

const sources = ["src", "electron", "packages"].flatMap((dir) => {
  const root = path.join(repoRoot, dir);
  return [...productSources(root)].map((file) => ({
    relative: path.relative(repoRoot, file).split(path.sep).join("/"),
    text: readFileSync(file, "utf8"),
  }));
});

describe("the renderer's closure of the chat IR route (B-T6)", () => {
  it("is false", () => {
    expect(CHAT_AGENT_IR_ENABLED).toBe(false);
  });

  it("is declared once in product sources, as `false as const`", () => {
    const declarations = sources.filter((source) =>
      /\bconst\s+CHAT_AGENT_IR_ENABLED\b/u.test(source.text),
    );
    expect(declarations.map((source) => source.relative)).toEqual([
      CONSTANT_FILE,
    ]);
    expect(declarations[0]!.text).toMatch(
      /export const CHAT_AGENT_IR_ENABLED = false as const;/u,
    );
  });

  it("is not declared as `let`/`var` and not re-exported", () => {
    for (const source of sources) {
      expect(source.text, source.relative).not.toMatch(
        /\b(?:let|var)\s+CHAT_AGENT_IR_ENABLED\b/u,
      );
      if (source.relative === CONSTANT_FILE) continue;
      expect(source.text, source.relative).not.toMatch(
        /export\s*\{[^}]*CHAT_AGENT_IR_ENABLED/u,
      );
    }
  });

  it("is imported by no product source's static wrapper import (the wrapper has no static importer)", () => {
    const importing: string[] = [];
    for (const source of sources) {
      if (source.relative === WRAPPER) continue;
      const specifiers = [
        ...source.text.matchAll(/\bfrom\s*["']([^"']+)["']/gu),
        ...source.text.matchAll(/(?:^|[\n;])\s*import\s*["']([^"']+)["']/gu),
      ].map((match) => match[1]!);
      if (
        specifiers.some((specifier) =>
          /(?:^|\/)chatIr(?:\.[cm]?[jt]sx?)?$/u.test(specifier),
        )
      ) {
        importing.push(source.relative);
      }
    }
    expect(importing).toEqual([]);
  });

  it("keeps the product-side files of S1-B free of the Native gate's wire name", () => {
    // S1-A's S1-7 scan covers every product source; this names S1-B's files.
    const name = ["chat", "agent", "ir"].join("-");
    const own = [
      "electron/shared/chatAgentIrWire.ts",
      WRAPPER,
      CONSTANT_FILE,
      "src/features/chat/agent/chatTurnToolScope.ts",
      "src/features/chronicle/chronicleReadingPosition.ts",
    ];
    for (const relative of own) {
      const source = sources.find(
        (candidate) => candidate.relative === relative,
      );
      expect(source, relative).toBeDefined();
      expect(source!.text, relative).not.toContain(name);
    }
  });
});
