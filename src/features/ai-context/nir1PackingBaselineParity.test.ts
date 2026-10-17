import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import vectors from "../../../evals/nir1-packing/final-request-baseline-parity.v1.json";
import { selectContextItems } from "./budgetSelector";
import type { ContextAuthority, ContextDecision, ContextItem } from "./types";

// Parity vectors for the P-12 baseline arm (K6/2 "P-12 の baseline arm" 7, DSN
// D-14). The vectors are the output of the TS `selectContextItems` for
// synthetic items mapped with the kind table; the Rust baseline arm (DPH-3)
// must return the same selection, decisions and usage. This file fixes "the TS
// output equals the vectors" and "the kind table and the authority ranks equal
// the TS sources", so a change in either TS function fails here before the
// Rust arm is compared.

interface VectorItem {
  key: string;
  kind: string;
  tokens: number;
}

interface VectorExpected {
  /** Raw alone exceeds the budget: the arm returns the typed input-reduction result. */
  inputReductionRequired: boolean;
  selectedKeys: string[];
  decisions: ContextDecision[];
  usage: {
    candidateTokens: number;
    selectedTokens: number;
    trimmedTokens: number;
    budgetTokens: number | null;
  };
}

interface VectorCase {
  name: string;
  budgetTokens: number;
  items: VectorItem[];
  expected?: VectorExpected;
}

interface Vectors {
  schemaVersion: string;
  kindTable: Record<string, { authority: ContextAuthority; priority: number }>;
  authorityRetentionRank: Record<string, number>;
  cases: VectorCase[];
  [key: string]: unknown;
}

const vectorPath = fileURLToPath(
  new URL(
    "../../../evals/nir1-packing/final-request-baseline-parity.v1.json",
    import.meta.url,
  ),
);
const typedVectors = vectors as unknown as Vectors;

function toContextItem(
  item: VectorItem,
): ContextItem<{ tokens: number }, string> {
  const mapped = typedVectors.kindTable[item.kind];
  if (!mapped) throw new Error(`unknown kind ${item.kind}`);
  return {
    key: item.key,
    kind: item.kind,
    authority: mapped.authority,
    priority: mapped.priority,
    stability: "turn-volatile",
    trim: { mode: "atomic", minTokens: item.tokens, maxTokens: item.tokens },
    provenance: { sourceType: "nir1-final-request-parity", sourceId: item.key },
    payload: { tokens: item.tokens },
  };
}

function run(vectorCase: VectorCase): VectorExpected {
  const selection = selectContextItems({
    items: vectorCase.items.map(toContextItem),
    budgetTokens: vectorCase.budgetTokens,
    measureSelectionTokens: (items) =>
      items.reduce((total, item) => total + item.payload.tokens, 0),
    measureItemTokens: (item) => item.payload.tokens,
  });
  const rawTokens = vectorCase.items
    .filter((item) => item.kind === "raw")
    .reduce((total, item) => total + item.tokens, 0);
  return {
    inputReductionRequired: rawTokens > vectorCase.budgetTokens,
    selectedKeys: selection.selectedItems.map((item) => item.key),
    decisions: selection.decisions,
    usage: { ...selection.usage },
  };
}

function readSource(relative: string): string {
  return readFileSync(
    fileURLToPath(new URL(relative, import.meta.url)),
    "utf8",
  );
}

function functionBody(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  expect(start, `${name} exists`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf("\n}\n", start);
  return source.slice(start, end);
}

function caseTable(body: string): Record<string, string> {
  const table: Record<string, string> = {};
  const pattern =
    /case "([a-z-]+)":\s*(?:\/\/[^\n]*\n\s*)*return ("[a-z_]+"|\d+);/g;
  for (const match of body.matchAll(pattern)) {
    table[match[1]] = match[2].replaceAll('"', "");
  }
  return table;
}

describe("P-12 baseline parity vectors", () => {
  it("regenerates the expected output only when asked", () => {
    if (process.env.NIR1_PARITY_UPDATE !== "1") return;
    const next = {
      ...typedVectors,
      cases: typedVectors.cases.map((vectorCase) => ({
        ...vectorCase,
        expected: run(vectorCase),
      })),
    };
    writeFileSync(vectorPath, `${JSON.stringify(next, null, 2)}\n`);
  });

  it("has the declared schema and a closed kind table", () => {
    expect(typedVectors.schemaVersion).toBe(
      "nir1-final-request-baseline-parity/1",
    );
    expect(Object.keys(typedVectors.kindTable).sort()).toEqual([
      "accepted-ir",
      "author-declared",
      "graph-evidence",
      "raw",
      "unreviewed-for-review",
    ]);
    const names = typedVectors.cases.map((vectorCase) => vectorCase.name);
    expect(new Set(names).size).toBe(names.length);
    for (const vectorCase of typedVectors.cases) {
      expect(
        vectorCase.items.filter((item) => item.kind === "raw"),
      ).toHaveLength(1);
      expect(vectorCase.expected, vectorCase.name).toBeDefined();
    }
  });

  for (const vectorCase of typedVectors.cases) {
    it(`TS selectContextItems matches the vector: ${vectorCase.name}`, () => {
      expect(run(vectorCase)).toEqual(vectorCase.expected);
    });
  }

  it("pins the removal behaviors the Rust arm must reproduce", () => {
    const byName = new Map(
      typedVectors.cases.map((vectorCase) => [vectorCase.name, vectorCase]),
    );
    const selected = (name: string) => byName.get(name)?.expected?.selectedKeys;
    expect(selected("fits-within-budget-keeps-every-item")).toEqual([
      "raw",
      "ir-a",
      "graph-a",
    ]);
    expect(selected("lowest-authority-yields-first")).toEqual([
      "raw",
      "ir-a",
      "graph-a",
    ]);
    expect(selected("removal-stops-at-the-first-fit")).toEqual(["raw", "ir-a"]);
    expect(selected("priority-orders-within-the-same-authority")).toEqual([
      "raw",
      "ir-a",
    ]);
    expect(selected("original-order-breaks-a-full-tie")).toEqual([
      "raw",
      "graph-c",
      "graph-d",
    ]);
    expect(selected("one-token-over-removes-the-lowest-ranked-item")).toEqual([
      "raw",
      "ir-a",
    ]);
    // Raw is removed last. When Raw alone exceeds the budget the pure selector
    // removes it too, and the arm must report input reduction instead.
    const rawAlone = byName.get(
      "raw-alone-over-budget-is-removed-last-by-the-pure-selector",
    );
    expect(rawAlone?.expected?.inputReductionRequired).toBe(true);
    expect(rawAlone?.expected?.selectedKeys).toEqual([]);
    for (const vectorCase of typedVectors.cases) {
      if (vectorCase !== rawAlone) {
        expect(
          vectorCase.expected?.inputReductionRequired,
          vectorCase.name,
        ).toBe(false);
      }
    }
    expect(selected("every-non-raw-item-removed-leaves-raw-only")).toEqual([
      "raw",
    ]);
  });

  it("uses the kind table and authority ranks of the TS sources", () => {
    const packing = readSource("./nir1Packing.ts");
    const authority = caseTable(functionBody(packing, "authorityForKind"));
    const priority = caseTable(functionBody(packing, "priorityForKind"));
    for (const [kind, mapped] of Object.entries(typedVectors.kindTable)) {
      expect(authority[kind], `${kind} authority`).toBe(mapped.authority);
      expect(priority[kind], `${kind} priority`).toBe(String(mapped.priority));
    }
    expect(Object.keys(authority).sort()).toEqual(
      Object.keys(typedVectors.kindTable).sort(),
    );

    const selector = readSource("./budgetSelector.ts");
    const start = selector.indexOf("AUTHORITY_RETENTION_RANK");
    const block = selector.slice(
      selector.indexOf("{", start),
      selector.indexOf("};", start),
    );
    const ranks: Record<string, number> = {};
    for (const match of block.matchAll(/(\w+):\s*(\d+)/g)) {
      ranks[match[1]] = Number(match[2]);
    }
    expect(ranks).toEqual(typedVectors.authorityRetentionRank);
  });
});
