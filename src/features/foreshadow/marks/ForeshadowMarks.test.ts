// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { ForeshadowSetupMark } from "./ForeshadowSetupMark";
import { ForeshadowPayoffMark } from "./ForeshadowPayoffMark";
import {
  ForeshadowPasteRule,
  stripForeshadowMarks,
} from "./foreshadowPasteRule";
import { Fragment } from "@tiptap/pm/model";

function createTestEditor() {
  return new Editor({
    extensions: [
      StarterKit,
      ForeshadowSetupMark,
      ForeshadowPayoffMark,
      ForeshadowPasteRule,
    ],
    content: "<p>テスト</p>",
  });
}

describe("ForeshadowSetupMark", () => {
  it("registers as a mark extension", () => {
    const ed = createTestEditor();
    expect(ed.schema.marks["foreshadowSetup"]).toBeDefined();
    ed.destroy();
  });

  it("has setupId and foreshadowId attrs", () => {
    const ed = createTestEditor();
    const markType = ed.schema.marks["foreshadowSetup"];
    expect(markType.spec.attrs).toHaveProperty("setupId");
    expect(markType.spec.attrs).toHaveProperty("foreshadowId");
    ed.destroy();
  });

  it("inclusive is false (does not extend on insert)", () => {
    const ed = createTestEditor();
    const markType = ed.schema.marks["foreshadowSetup"];
    expect(markType.spec.inclusive).toBe(false);
    ed.destroy();
  });

  it("can apply setup mark with attrs", () => {
    const ed = createTestEditor();
    ed.chain()
      .focus()
      .insertContent([
        {
          type: "text",
          text: "伏線テキスト",
          marks: [
            {
              type: "foreshadowSetup",
              attrs: { setupId: "s-001", foreshadowId: "f-001" },
            },
          ],
        },
      ])
      .run();

    let found = false;
    ed.state.doc.descendants((node) => {
      if (!node.isText) return;
      const m = node.marks.find((m) => m.type.name === "foreshadowSetup");
      if (m) {
        expect(m.attrs.setupId).toBe("s-001");
        expect(m.attrs.foreshadowId).toBe("f-001");
        found = true;
      }
    });
    expect(found).toBe(true);
    ed.destroy();
  });
});

describe("ForeshadowPayoffMark", () => {
  it("registers as a mark extension", () => {
    const ed = createTestEditor();
    expect(ed.schema.marks["foreshadowPayoff"]).toBeDefined();
    ed.destroy();
  });

  it("has foreshadowId attr", () => {
    const ed = createTestEditor();
    const markType = ed.schema.marks["foreshadowPayoff"];
    expect(markType.spec.attrs).toHaveProperty("foreshadowId");
    ed.destroy();
  });

  it("can apply payoff mark with foreshadowId", () => {
    const ed = createTestEditor();
    ed.chain()
      .focus()
      .insertContent([
        {
          type: "text",
          text: "回収テキスト",
          marks: [
            {
              type: "foreshadowPayoff",
              attrs: { foreshadowId: "f-002" },
            },
          ],
        },
      ])
      .run();

    let found = false;
    ed.state.doc.descendants((node) => {
      if (!node.isText) return;
      const m = node.marks.find((m) => m.type.name === "foreshadowPayoff");
      if (m) {
        expect(m.attrs.foreshadowId).toBe("f-002");
        found = true;
      }
    });
    expect(found).toBe(true);
    ed.destroy();
  });
});

describe("ForeshadowPasteRule", () => {
  it("extension registers without error", () => {
    const ed = createTestEditor();
    // ForeshadowPasteRule has no named mark — just verify the editor built ok
    expect(ed.schema.marks["foreshadowSetup"]).toBeDefined();
    ed.destroy();
  });

  it("stripForeshadowMarks removes setup mark from text node", () => {
    const ed = createTestEditor();
    const setupMarkType = ed.schema.marks["foreshadowSetup"];
    const textNode = ed.schema.text("テキスト", [
      setupMarkType.create({ setupId: "s-x", foreshadowId: "f-x" }),
    ]);
    const frag = Fragment.from(textNode);

    const result = stripForeshadowMarks(frag);
    let hasSetupMark = false;
    result.descendants((node) => {
      if (!node.isText) return;
      if (node.marks.find((m) => m.type.name === "foreshadowSetup"))
        hasSetupMark = true;
    });
    expect(hasSetupMark).toBe(false);
    ed.destroy();
  });

  it("stripForeshadowMarks removes payoff mark from text node", () => {
    const ed = createTestEditor();
    const payoffMarkType = ed.schema.marks["foreshadowPayoff"];
    const textNode = ed.schema.text("テキスト", [
      payoffMarkType.create({ foreshadowId: "f-y" }),
    ]);
    const frag = Fragment.from(textNode);

    const result = stripForeshadowMarks(frag);
    let hasPayoffMark = false;
    result.descendants((node) => {
      if (!node.isText) return;
      if (node.marks.find((m) => m.type.name === "foreshadowPayoff"))
        hasPayoffMark = true;
    });
    expect(hasPayoffMark).toBe(false);
    ed.destroy();
  });

  it("stripForeshadowMarks preserves non-foreshadow marks", () => {
    const ed = createTestEditor();
    const boldMarkType = ed.schema.marks["bold"];
    const setupMarkType = ed.schema.marks["foreshadowSetup"];
    const textNode = ed.schema.text("太字伏線", [
      boldMarkType.create(),
      setupMarkType.create({ setupId: "s-z", foreshadowId: "f-z" }),
    ]);
    const frag = Fragment.from(textNode);

    const result = stripForeshadowMarks(frag);
    let hasBold = false;
    let hasSetup = false;
    result.descendants((node) => {
      if (!node.isText) return;
      if (node.marks.find((m) => m.type.name === "bold")) hasBold = true;
      if (node.marks.find((m) => m.type.name === "foreshadowSetup"))
        hasSetup = true;
    });
    expect(hasBold).toBe(true);
    expect(hasSetup).toBe(false);
    ed.destroy();
  });
});
