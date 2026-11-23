import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { TREE_NODE_RESTORE_STATE_KEYS } from "../../../electron/shared/ipcContract";

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

  it("the renderer reads every key from the row (loadTreeNodeRestoreSnapshot)", () => {
    const text = read("src/features/tree/api.ts");
    const fn = text.slice(
      text.indexOf("export async function loadTreeNodeRestoreSnapshot"),
    );
    for (const key of main) {
      expect(fn.includes(`${key}:`) || fn.includes(`"${key}"`), key).toBe(true);
    }
  });
});
