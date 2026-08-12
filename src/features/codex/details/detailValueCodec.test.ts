import { describe, expect, it } from "vitest";

import { detailValueCodec } from "./detailValueCodec";

const TEXT_DEFINITION = {
  definitionId: "def-status",
  definitionRef: "D001",
  name: "現在の立場",
  fieldType: "text",
  fieldConfig: null,
} as const;

const DROPDOWN_DEFINITION = {
  definitionId: "def-role",
  definitionRef: "D002",
  name: "役割",
  fieldType: "dropdown",
  fieldConfig: JSON.stringify({
    options: ["主人公", "主要人物"],
  }),
  options: [
    { optionRef: "O001", label: "主人公" },
    { optionRef: "O002", label: "主要人物" },
  ],
} as const;

const REFERENCE_DEFINITION = {
  definitionId: "def-owner",
  definitionRef: "D003",
  name: "所有者",
  fieldType: "codex_reference",
  fieldConfig: null,
} as const;

const CANONICAL_TEXT =
  '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"共和国監察局に所属"}]}]}';

describe("detailValueCodec", () => {
  it("encodes new base and Phase text writes as the same canonical minimal ProseMirror document", () => {
    const value = { kind: "text", text: "共和国監察局に所属" } as const;

    expect(detailValueCodec.encodeBase(TEXT_DEFINITION, value)).toBe(
      CANONICAL_TEXT,
    );
    expect(detailValueCodec.encodePhaseOverride(TEXT_DEFINITION, value)).toBe(
      CANONICAL_TEXT,
    );
  });

  it("decodes both legacy plain Phase text and canonical ProseMirror text", () => {
    expect(
      detailValueCodec.decode(TEXT_DEFINITION, "共和国監察局に所属"),
    ).toEqual({ kind: "text", text: "共和国監察局に所属" });
    expect(detailValueCodec.decode(TEXT_DEFINITION, CANONICAL_TEXT)).toEqual({
      kind: "text",
      text: "共和国監察局に所属",
    });
  });

  it("decodes the existing empty ProseMirror sentinel as empty text", () => {
    expect(detailValueCodec.decode(TEXT_DEFINITION, "{}")).toEqual({
      kind: "text",
      text: "",
    });
  });

  it("round-trips text whitespace losslessly instead of collapsing it", () => {
    const value = { kind: "text", text: "西部軍  所属\n門兵" } as const;
    const encoded = detailValueCodec.encodeBase(TEXT_DEFINITION, value);

    expect(encoded).not.toBeNull();
    expect(detailValueCodec.decode(TEXT_DEFINITION, encoded)).toEqual(value);
  });

  it("keeps nested legacy block boundaries instead of concatenating list items", () => {
    const storedValue = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "Western Army" }],
                },
              ],
            },
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "Gate Guard" }],
                },
              ],
            },
          ],
        },
      ],
    });

    expect(detailValueCodec.decode(TEXT_DEFINITION, storedValue)).toEqual({
      kind: "text",
      text: "Western Army\nGate Guard",
    });
  });

  it("decodes a stored NULL as explicit clear; row absence stays outside the codec", () => {
    expect(detailValueCodec.decode(TEXT_DEFINITION, null)).toEqual({
      kind: "clear",
    });
    expect(
      detailValueCodec.encodePhaseOverride(TEXT_DEFINITION, { kind: "clear" }),
    ).toBeNull();
  });

  it("keeps empty text distinct from explicit clear", () => {
    const encoded = detailValueCodec.encodeBase(TEXT_DEFINITION, {
      kind: "text",
      text: "",
    });

    expect(encoded).not.toBeNull();
    expect(detailValueCodec.decode(TEXT_DEFINITION, encoded)).toEqual({
      kind: "text",
      text: "",
    });
  });

  it("maps only declared opaque dropdown option refs to their stored labels", () => {
    expect(
      detailValueCodec.encodeBase(DROPDOWN_DEFINITION, {
        kind: "enum",
        optionRef: "O001",
      }),
    ).toBe("主人公");
    expect(detailValueCodec.decode(DROPDOWN_DEFINITION, "主人公")).toEqual({
      kind: "enum",
      optionRef: "O001",
    });
  });

  it("rejects an unknown dropdown option instead of guessing a nearby option", () => {
    expect(() =>
      detailValueCodec.encodeBase(DROPDOWN_DEFINITION, {
        kind: "enum",
        optionRef: "O999",
      }),
    ).toThrow(/option/i);
    expect(() =>
      detailValueCodec.decode(DROPDOWN_DEFINITION, "敵対者"),
    ).toThrow(/option/i);
  });

  it("rejects a projected value whose kind is incompatible with the field type", () => {
    expect(() =>
      detailValueCodec.encodeBase(TEXT_DEFINITION, {
        kind: "enum",
        optionRef: "O001",
      }),
    ).toThrow(/field type|incompatible/i);
  });

  it("requires an explicit Entity Binding resolver for codex_reference", () => {
    expect(() =>
      detailValueCodec.decode(REFERENCE_DEFINITION, "entry-raika"),
    ).toThrow(/entity binding|resolver/i);
    expect(() =>
      detailValueCodec.encodeBase(REFERENCE_DEFINITION, {
        kind: "entity",
        entityId: "entity:raika",
      }),
    ).toThrow(/entity binding|resolver/i);
  });

  it("round-trips codex_reference through the supplied Entity Binding resolver", () => {
    const context = {
      entityReferences: {
        narrativeEntityIdForEntryId: (entryId: string) =>
          entryId === "entry-raika" ? "entity:raika" : null,
        entryIdForNarrativeEntityId: (entityId: string) =>
          entityId === "entity:raika" ? "entry-raika" : null,
      },
    };

    expect(
      detailValueCodec.decode(REFERENCE_DEFINITION, "entry-raika", context),
    ).toEqual({ kind: "entity", entityId: "entity:raika" });
    expect(
      detailValueCodec.encodePhaseOverride(
        REFERENCE_DEFINITION,
        { kind: "entity", entityId: "entity:raika" },
        context,
      ),
    ).toBe("entry-raika");
  });

  it("rejects empty runtime values returned by an Entity Binding resolver", () => {
    const invalidContext = {
      entityReferences: {
        narrativeEntityIdForEntryId: () => "",
        entryIdForNarrativeEntityId: () => "",
      },
    };

    expect(() =>
      detailValueCodec.decode(
        REFERENCE_DEFINITION,
        "entry-raika",
        invalidContext,
      ),
    ).toThrow(/binding/i);
    expect(() =>
      detailValueCodec.encodeBase(
        REFERENCE_DEFINITION,
        { kind: "entity", entityId: "entity:raika" },
        invalidContext,
      ),
    ).toThrow(/binding/i);
  });
});
