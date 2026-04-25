import { Extension } from "@tiptap/core";
import { Fragment, Slice } from "@tiptap/pm/model";
import { Plugin } from "@tiptap/pm/state";
import type { Node } from "@tiptap/pm/model";

export function stripForeshadowMarks(fragment: Fragment): Fragment {
  const nodes: Node[] = [];
  fragment.forEach((node) => {
    if (node.isText) {
      const filtered = node.marks.filter(
        (m) =>
          m.type.name !== "foreshadowSetup" &&
          m.type.name !== "foreshadowPayoff",
      );
      nodes.push(node.mark(filtered));
    } else {
      nodes.push(node.copy(stripForeshadowMarks(node.content)));
    }
  });
  return Fragment.from(nodes);
}

export const ForeshadowPasteRule = Extension.create({
  name: "foreshadowPasteRule",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          transformPasted(slice) {
            return new Slice(
              stripForeshadowMarks(slice.content),
              slice.openStart,
              slice.openEnd,
            );
          },
        },
      }),
    ];
  },
});
