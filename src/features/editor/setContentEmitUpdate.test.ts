// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import { getEditorExtensions } from "@/features/editor/extensions";
import { useTabStore } from "@/features/editor/tabStore";

/**
 * Regression guard for commit c020086.
 *
 * Contract: `editor.commands.setContent(content, { emitUpdate: false })`
 * must NOT trigger `onUpdate`. EditorPane/LinearSceneBlock depend on this
 * to load scene content without the onUpdate handler promoting the active
 * preview tab to pinned via `pinTab`.
 *
 * This test guards the contract at the TipTap layer only. It does NOT
 * prevent a new call site from omitting the flag — that would need
 * EditorPane-level integration coverage.
 */

function resetTabs() {
  useTabStore.setState({
    tabs: [],
    activeTabId: null,
    secondaryTabs: [],
    secondaryActiveTabId: null,
  });
}

function makeEditor(nodeId: string) {
  return new Editor({
    extensions: getEditorExtensions(),
    content: "",
    onUpdate: () => {
      useTabStore.getState().pinTab(nodeId);
    },
  });
}

async function flushPending() {
  // The original bug was onUpdate firing *after* setContent returned.
  // Flush microtasks + a macrotask so any delayed dispatch settles before
  // we assert.
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

describe("setContent emitUpdate:false contract", () => {
  beforeEach(() => {
    resetTabs();
  });

  let editor: Editor | null = null;

  afterEach(() => {
    editor?.destroy();
    editor = null;
  });

  it("preserves preview tab when setContent is called with emitUpdate:false", async () => {
    const nodeId = "scene-a";
    useTabStore.getState().openPreview(nodeId);
    expect(useTabStore.getState().tabs[0].isPreview).toBe(true);

    editor = makeEditor(nodeId);

    editor.commands.setContent("<p>loaded scene content</p>", {
      emitUpdate: false,
    });
    await flushPending();

    expect(useTabStore.getState().tabs[0].isPreview).toBe(true);
  });

  it("baseline: setContent WITHOUT the flag does fire onUpdate and pins the preview tab", async () => {
    // Control: without { emitUpdate: false } the bug reproduces.
    // If this assertion ever flips (tab stays preview), the regression test
    // above would give false confidence — so this baseline must fail loudly.
    const nodeId = "scene-b";
    useTabStore.getState().openPreview(nodeId);
    expect(useTabStore.getState().tabs[0].isPreview).toBe(true);

    editor = makeEditor(nodeId);

    editor.commands.setContent("<p>loaded scene content</p>");
    await flushPending();

    expect(useTabStore.getState().tabs[0].isPreview).toBe(false);
  });
});
