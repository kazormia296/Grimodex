import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { prosemirrorToText } from "@/lib/prosemirror";
import { buildSemanticRecallQuery } from "@/features/chat/semanticRecall";

const fixtures = JSON.parse(
  readFileSync("evals/nir1-retrieval/raw-query-parity.json", "utf8"),
) as {
  cases: Array<{
    id: string;
    content: string;
    queryUtf16: number[];
    nativeQuery: string;
  }>;
};

describe("frozen Raw query parity at the Native boundary", () => {
  it.each(fixtures.cases)("$id", ({ content, queryUtf16, nativeQuery }) => {
    const query = buildSemanticRecallQuery({
      userMessage: "",
      sceneBody: prosemirrorToText(content),
    });
    expect(
      Array.from({ length: query.length }, (_, index) =>
        query.charCodeAt(index),
      ),
    ).toEqual(queryUtf16);
    expect(Buffer.from(query, "utf8").toString("utf8")).toBe(nativeQuery);
  });
});
