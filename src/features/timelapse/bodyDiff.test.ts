import { describe, it, expect } from "vitest";
import { computeBodyDiff, computeDocDiff, extractDocText } from "./bodyDiff";

function pmDoc(text: string): string {
  return JSON.stringify({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  });
}

describe("computeBodyDiff", () => {
  it("identical text returns null", () => {
    expect(computeBodyDiff("hello", "hello")).toBeNull();
  });

  it("both empty / nullish returns null", () => {
    expect(computeBodyDiff("", "")).toBeNull();
    expect(computeBodyDiff(null, null)).toBeNull();
    expect(computeBodyDiff(undefined, undefined)).toBeNull();
    expect(computeBodyDiff(null, "")).toBeNull();
  });

  it("insertion into empty is a single insert segment", () => {
    const d = computeBodyDiff("", "hello");
    expect(d).not.toBeNull();
    expect(d!.truncated).toBeFalsy();
    expect(d!.segments).toEqual([[1, "hello"]]);
  });

  it("deletion to empty is a single delete segment", () => {
    const d = computeBodyDiff("hello", "");
    expect(d!.segments).toEqual([[-1, "hello"]]);
  });

  it("nullish before is treated as empty (all insert)", () => {
    expect(computeBodyDiff(null, "x")!.segments).toEqual([[1, "x"]]);
    expect(computeBodyDiff("x", null)!.segments).toEqual([[-1, "x"]]);
  });

  it("short edits keep equal context whole and reconstruct both sides", () => {
    const before = "the quick brown fox";
    const after = "the slow brown fox";
    const d = computeBodyDiff(before, after)!;
    expect(d.truncated).toBeFalsy();
    // delete + insert of the changed word must be present
    expect(d.segments).toContainEqual([-1, "quick"]);
    expect(d.segments).toContainEqual([1, "slow"]);
    // reconstruct invariant (only valid when nothing was trimmed)
    const reconBefore = d.segments
      .filter(([op]) => op !== 1)
      .map(([, t]) => t)
      .join("");
    const reconAfter = d.segments
      .filter(([op]) => op !== -1)
      .map(([, t]) => t)
      .join("");
    expect(reconBefore).toBe(before);
    expect(reconAfter).toBe(after);
  });

  it("handles Japanese text and reconstructs for short input", () => {
    const before = "猫が走る";
    const after = "犬が走る";
    const d = computeBodyDiff(before, after)!;
    const reconBefore = d.segments
      .filter(([op]) => op !== 1)
      .map(([, t]) => t)
      .join("");
    const reconAfter = d.segments
      .filter(([op]) => op !== -1)
      .map(([, t]) => t)
      .join("");
    expect(reconBefore).toBe(before);
    expect(reconAfter).toBe(after);
  });

  it("trims long unchanged runs so the diff is change-proportional", () => {
    const filler = "あ".repeat(2000);
    const before = filler + "X";
    const after = filler + "Y";
    const d = computeBodyDiff(before, after)!;
    // The 2000-char unchanged run must NOT be stored verbatim.
    const totalChars = d.segments.reduce((n, [, t]) => n + t.length, 0);
    expect(totalChars).toBeLessThan(200);
    // The actual change is still captured.
    expect(d.segments).toContainEqual([-1, "X"]);
    expect(d.segments).toContainEqual([1, "Y"]);
  });

  it("caps a huge change and flags it truncated", () => {
    const after = "Y".repeat(50_000);
    const d = computeBodyDiff("", after)!;
    expect(d.truncated).toBe(true);
    const totalChars = d.segments.reduce((n, [, t]) => n + t.length, 0);
    // bounded well under the input size
    expect(totalChars).toBeLessThanOrEqual(9000);
  });
});

describe("extractDocText", () => {
  it("pulls concatenated text out of a ProseMirror doc", () => {
    expect(extractDocText(pmDoc("hello world"))).toBe("hello world");
  });

  it("returns empty for empty doc / null / invalid JSON", () => {
    expect(extractDocText('{"type":"doc","content":[]}')).toBe("");
    expect(extractDocText(null)).toBe("");
    expect(extractDocText(undefined)).toBe("");
    expect(extractDocText("not json")).toBe("");
  });

  it("joins text across multiple nodes", () => {
    const doc = JSON.stringify({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "ab" }] },
        { type: "paragraph", content: [{ type: "text", text: "cd" }] },
      ],
    });
    expect(extractDocText(doc)).toBe("abcd");
  });
});

describe("computeDocDiff", () => {
  it("diffs the extracted text, not the raw JSON", () => {
    const d = computeDocDiff(pmDoc("猫が走る"), pmDoc("犬が走る"))!;
    expect(d).not.toBeNull();
    // The JSON braces/keys must NOT appear in the diff segments.
    const joined = d.segments.map(([, t]) => t).join("");
    expect(joined).not.toContain("paragraph");
    expect(joined).not.toContain("{");
    // The actual textual change is captured.
    expect(d.segments).toContainEqual([-1, "猫"]);
    expect(d.segments).toContainEqual([1, "犬"]);
  });

  it("returns null when extracted text is unchanged (formatting-only edit)", () => {
    const plain = pmDoc("same text");
    const bold = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "same text", marks: [{ type: "bold" }] },
          ],
        },
      ],
    });
    expect(computeDocDiff(plain, bold)).toBeNull();
  });

  it("treats empty default doc as empty text", () => {
    const d = computeDocDiff('{"type":"doc","content":[]}', pmDoc("new"))!;
    expect(d.segments).toEqual([[1, "new"]]);
  });
});
