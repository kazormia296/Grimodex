import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  AI_IPC_TIMEOUT_MS,
  IPC_TIMEOUT_MS,
  MAIN_READ_CALLER_TIMEOUT_MS,
} from "./ipcCallerTimeouts.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const tauriSource = readFileSync(
  path.join(repoRoot, "src", "lib", "tauri.ts"),
  "utf8",
);

describe("the shared caller timeouts", () => {
  it("keep the values the renderer has always used", () => {
    expect(IPC_TIMEOUT_MS).toBe(10_000);
    expect(AI_IPC_TIMEOUT_MS).toBe(300_000);
  });

  it("give main's four timed reads the renderer's values, and no other command", () => {
    expect(MAIN_READ_CALLER_TIMEOUT_MS).toEqual({
      db_execute: 10_000,
      fts_search: 10_000,
      codex_semantic_search: 300_000,
      events_semantic_search: 300_000,
    });
    expect(Object.isFrozen(MAIN_READ_CALLER_TIMEOUT_MS)).toBe(true);
    // The renderer gives this one no caller timeout; none is placed here.
    expect(MAIN_READ_CALLER_TIMEOUT_MS).not.toHaveProperty(
      "foreshadow_list_open_for_context",
    );
  });

  it("is a leaf: it imports nothing, and names no chat IR command", () => {
    const source = readFileSync(
      path.join(repoRoot, "electron", "shared", "ipcCallerTimeouts.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/^\s*import\s/mu);
    expect(source).not.toMatch(/chat[-_]?agent[-_]?ir/iu);
  });
});

describe("the renderer and main read the same module", () => {
  it("tauri.ts imports both values from the shared module and defines neither", () => {
    expect(tauriSource).toMatch(
      /import\s*\{[^}]*\bAI_IPC_TIMEOUT_MS\b[^}]*\}\s*from\s*"@\/\.\.\/electron\/shared\/ipcCallerTimeouts"/u,
    );
    expect(tauriSource).toMatch(
      /import\s*\{[^}]*\bIPC_TIMEOUT_MS\b[^}]*\}\s*from\s*"@\/\.\.\/electron\/shared\/ipcCallerTimeouts"/u,
    );
    expect(tauriSource).not.toMatch(/\bconst\s+IPC_TIMEOUT_MS\b/u);
    expect(tauriSource).not.toMatch(/\bconst\s+AI_IPC_TIMEOUT_MS\b/u);
  });

  it("tauri.ts's table gives the three commands the same constants as main's table", () => {
    const table = new Map<string, string>();
    for (const match of tauriSource.matchAll(
      /\["(\w+)",\s*(IPC_TIMEOUT_MS|AI_IPC_TIMEOUT_MS)\]/gu,
    )) {
      table.set(match[1]!, match[2]!);
    }
    const value = (name: string) =>
      name === "IPC_TIMEOUT_MS" ? IPC_TIMEOUT_MS : AI_IPC_TIMEOUT_MS;
    for (const command of [
      "fts_search",
      "codex_semantic_search",
      "events_semantic_search",
    ] as const) {
      expect(table.has(command), command).toBe(true);
      expect(value(table.get(command)!), command).toBe(
        MAIN_READ_CALLER_TIMEOUT_MS[command],
      );
    }
    // And the renderer has no caller timeout for this one.
    expect(table.has("foreshadow_list_open_for_context")).toBe(false);
  });

  it("tauri.ts gives a read-only db_execute the 10 s constant", () => {
    expect(tauriSource).toMatch(
      /command === "db_execute" && isReadOnlyDbExecute\(args\)\)\s*\{\s*return IPC_TIMEOUT_MS;/u,
    );
    expect(MAIN_READ_CALLER_TIMEOUT_MS.db_execute).toBe(IPC_TIMEOUT_MS);
  });
});
