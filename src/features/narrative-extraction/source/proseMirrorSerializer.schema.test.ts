import { getSchema } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { getEditorExtensions } from "@/features/editor/extensions";
import { getFileBackedEditorExtensions } from "@/features/external-mount/fileBackedEditorExtensions";
import { isCanonicalNodeTypeSupported } from "./proseMirrorSerializer";

describe("Canonical ProseMirror schema coverage", () => {
  it.each([
    ["database", getEditorExtensions({ setMentionPopup: () => {} })],
    ["file-backed", getFileBackedEditorExtensions()],
  ] as const)("registers every %s editor node type", (_name, extensions) => {
    const schema = getSchema(extensions);
    const unsupported = Object.keys(schema.nodes).filter(
      (nodeType) => !isCanonicalNodeTypeSupported(nodeType),
    );

    expect(unsupported).toEqual([]);
  });
});
