import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  TREE_NODE_RESTORE_STATE_INTEGER_KEYS,
  TREE_NODE_RESTORE_STATE_KEYS,
} from "../../../electron/shared/ipcContract";

// DR-UND-1: the `restoreState` key set is written out four times (Rust
// `TREE_NODE_RESTORE_COLUMNS`, Main `TREE_NODE_RESTORE_STATE_KEYS`, the browser
// mock's `BROWSER_TREE_RESTORE_COLUMNS`, the renderer's `TreeNodeRestoreState`).
// A key added to one and not the others would be silently refused (or silently
// dropped), so the four lists are compared here.

const root = path.resolve(__dirname, "../../..");
const read = (relative: string): string =>
  readFileSync(path.join(root, relative), "utf8");

function block(source: string, start: RegExp, end: string): string {
  const match = start.exec(source);
  if (!match) throw new Error(`block not found: ${start}`);
  const from = match.index + match[0].length;
  return source.slice(from, source.indexOf(end, from));
}

const sorted = (keys: readonly string[]): string[] => [...keys].sort();

describe("restoreState key set", () => {
  const main = sorted(TREE_NODE_RESTORE_STATE_KEYS);

  it("Rust TREE_NODE_RESTORE_COLUMNS lists the same keys as Main", () => {
    const text = block(
      read("src-tauri/crates/grimodex-db/src/domain_writes.rs"),
      /TREE_NODE_RESTORE_COLUMNS: \[\(&str, &str\); \d+\] = \[/,
      "];",
    );
    const keys = [...text.matchAll(/\("(\w+)", "\w+"\)/g)].map((m) => m[1]!);
    expect(sorted(keys)).toEqual(main);
  });

  it("Rust TreeNodeRestoreState has a field for each key", () => {
    const text = block(
      read("src-tauri/crates/grimodex-db/src/domain_writes.rs"),
      /pub struct TreeNodeRestoreState \{/,
      "\n}",
    );
    const camel = (snake: string): string =>
      snake.replace(/_(\w)/g, (_, c: string) => c.toUpperCase());
    const keys = [...text.matchAll(/pub (\w+): Option</g)].map((m) =>
      camel(m[1]!),
    );
    expect(sorted(keys)).toEqual(main);
  });

  it("the browser mock lists the same keys as Main", () => {
    const text = block(
      read("src/lib/browser-mock.ts"),
      /const BROWSER_TREE_RESTORE_COLUMNS[^=]*=\s*\[/,
      "];",
    );
    const keys = [...text.matchAll(/\["(\w+)", "\w+"\]/g)].map((m) => m[1]!);
    expect(sorted(keys)).toEqual(main);
  });

  it("the renderer's TreeNodeRestoreState has the same keys as Main", () => {
    const text = block(
      read("src/features/tree/api.ts"),
      /export interface TreeNodeRestoreState \{/,
      "\n}",
    );
    const keys = [...text.matchAll(/^\s+(\w+)\?:/gm)].map((m) => m[1]!);
    expect(sorted(keys)).toEqual(main);
  });

  it("the renderer reads every key from the row and sends it (loadTreeNodeRestoreSnapshot)", () => {
    const text = read("src/features/tree/api.ts");
    const start = text.indexOf(
      "export async function loadTreeNodeRestoreSnapshot",
    );
    // The function body only (up to its closing brace at column 0), not the
    // code after it, which also names some of these keys.
    const body = text.slice(start, text.indexOf("\n}\n", start));
    const select = block(body, /\.select\(\{/, "})");
    for (const key of main) {
      expect(
        select.includes(`${key}: treeNodes.${key},`),
        `select ${key}`,
      ).toBe(true);
      expect(
        body.includes(`"${key}"`) || body.includes(`restoreState.${key} =`),
        `send ${key}`,
      ).toBe(true);
    }
  });

  describe("the keys that carry an integer (the rest are strings)", () => {
    const integers = sorted(TREE_NODE_RESTORE_STATE_INTEGER_KEYS);

    it("Rust types exactly those keys as i64", () => {
      const text = block(
        read("src-tauri/crates/grimodex-db/src/domain_writes.rs"),
        /pub struct TreeNodeRestoreState \{/,
        "\n}",
      );
      const camel = (snake: string): string =>
        snake.replace(/_(\w)/g, (_, c: string) => c.toUpperCase());
      const keys = [...text.matchAll(/pub (\w+): Option<i64>/g)].map((m) =>
        camel(m[1]!),
      );
      expect(sorted(keys)).toEqual(integers);
    });

    it("the browser mock lists exactly those keys", () => {
      const text = block(
        read("src/lib/browser-mock.ts"),
        /const BROWSER_TREE_RESTORE_INTEGER_KEYS\s*=\s*\[/,
        "];",
      );
      const keys = [...text.matchAll(/"(\w+)"/g)].map((m) => m[1]!);
      expect(sorted(keys)).toEqual(integers);
    });

    it("the renderer types exactly those keys as number", () => {
      const text = block(
        read("src/features/tree/api.ts"),
        /export interface TreeNodeRestoreState \{/,
        "\n}",
      );
      const keys = [...text.matchAll(/^\s+(\w+)\?: number;/gm)].map(
        (m) => m[1]!,
      );
      expect(sorted(keys)).toEqual(integers);
    });

    it("every integer key is a restoreState key", () => {
      for (const key of integers) expect(main).toContain(key);
    });
  });
});

// The real-addon spec (electron/main/treeUndoRestore.pipeline.spec.ts) reaches
// the renderer API through an untyped import, so it carries a hand-written
// `TreeApiShape`. Its method names and parameter names (in order, a prefix of
// the real list: the spec may leave out trailing options) are compared with the
// declarations in api.ts, so a changed signature is caught here and not at the
// real-addon run.
describe("the real-addon spec's TreeApiShape matches api.ts", () => {
  const spec = read("electron/main/treeUndoRestore.pipeline.spec.ts");
  const api = read("src/features/tree/api.ts");

  const paramNames = (list: string): string[] => {
    const names: string[] = [];
    let depth = 0;
    let current = "";
    for (const ch of list) {
      if ("<([{".includes(ch)) depth += 1;
      if (">)]}".includes(ch)) depth -= 1;
      if (ch === "," && depth === 0) {
        names.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
    if (current.trim() !== "") names.push(current);
    return names
      .map((part) => /^\s*(\w+)\??\s*:/.exec(part)?.[1])
      .filter((name): name is string => name !== undefined);
  };

  const shape = block(spec, /interface TreeApiShape \{/, "\n}");
  const methods = [...shape.matchAll(/^ {2}(\w+)\(([\s\S]*?)\):\s*[^;]+;/gm)];

  it("lists the methods it calls", () => {
    expect(methods.map((m) => m[1]).sort()).toEqual(
      [
        "createNode",
        "deleteNode",
        "getNode",
        "historyWriteContext",
        "loadTreeNodeRestoreSnapshot",
        "updateNode",
        "updateTemporalScene",
      ].sort(),
    );
  });

  for (const name of [
    "createNode",
    "deleteNode",
    "getNode",
    "historyWriteContext",
    "loadTreeNodeRestoreSnapshot",
    "updateNode",
    "updateTemporalScene",
  ]) {
    it(`${name}: same parameter names, in order`, () => {
      const declared = new RegExp(
        `export (?:async )?function ${name}\\(([\\s\\S]*?)\\)(?::|\\s*\\{)`,
      ).exec(api);
      expect(declared, `${name} in api.ts`).not.toBeNull();
      const real = paramNames(declared![1]!);
      const hand = methods.find((m) => m[1] === name);
      expect(hand, `${name} in TreeApiShape`).toBeDefined();
      const mine = paramNames(hand![2]!);
      expect(real.slice(0, mine.length)).toEqual(mine);
      // Every required parameter of the real function is in the spec's shape.
      expect(mine.length).toBeGreaterThanOrEqual(
        real.filter(
          (_, index) =>
            !/^\s*\w+\?/.test(declared![1]!.split(",")[index] ?? ""),
        ).length,
      );
    });
  }
});
