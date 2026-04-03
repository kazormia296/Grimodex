import { Node, mergeAttributes } from "@tiptap/core";

/**
 * SceneBreakNode — シーン区切り (※ ※ ※)
 * An atomic block node rendered as a centered "* * *" divider.
 */
export const SceneBreakNode = Node.create({
  name: "sceneBreak",
  group: "block",
  atom: true,

  parseHTML() {
    return [{ tag: "div.scene-break" }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes({ class: "scene-break" }, HTMLAttributes),
      "* * *",
    ];
  },

  addCommands() {
    return {
      insertSceneBreak:
        () =>
        ({ commands }) => {
          return commands.insertContent({ type: this.name });
        },
    };
  },
});

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    sceneBreak: {
      insertSceneBreak: () => ReturnType;
    };
  }
}
