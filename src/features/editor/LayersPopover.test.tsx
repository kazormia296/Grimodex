// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createElement, createRef } from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { EditorState } from "@tiptap/pm/state";
import { Schema } from "@tiptap/pm/model";
import type { Editor } from "@tiptap/react";

import { Editor as TipTapEditor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";

import { useSettingsStore } from "@/features/settings/settingsStore";
import { useAttributionStore } from "@/features/attribution/attributionStore";
import { useAnnotationStore } from "@/features/post-effect/annotationStore";
import { useCursorSettingsStore } from "./cursorSettingsStore";
import { useCodexHighlightStore } from "./codexHighlightStore";
import { LayersPopover } from "./LayersPopover";
import { Toolbar } from "./Toolbar";

const showPanelSpy = vi.fn();

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

vi.mock("motion/react", () => ({
  motion: new Proxy(
    {},
    {
      get:
        (_target, tag: string) =>
        ({
          initial: _i,
          animate: _a,
          transition: _t,
          exit: _e,
          variants: _v,
          ...rest
        }: Record<string, unknown>) =>
          createElement(tag, rest as object),
    },
  ),
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  useReducedMotion: () => false,
}));

vi.mock("@/features/layout/layoutStore", () => ({
  useLayoutStore: {
    getState: () => ({ showPanel: showPanelSpy }),
  },
}));

vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: (
    selector: (s: { aiRatios: Record<string, number> }) => unknown,
  ) => selector({ aiRatios: { s1: 34 } }),
}));

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "inline*" },
    text: { group: "inline" },
  },
  marks: {
    comment: { attrs: { text: { default: "" } } },
    foreshadowSetup: {},
    foreshadowPayoff: {},
  },
});

function makeEditor(): { editor: Editor; dispatch: ReturnType<typeof vi.fn> } {
  const doc = schema.nodes.doc.create({}, [
    schema.nodes.paragraph.create({}, [
      schema.text("コメント付き", [schema.marks.comment.create()]),
      schema.text("あいだ"),
      schema.text("伏線", [schema.marks.foreshadowSetup.create()]),
    ]),
  ]);
  const state = EditorState.create({ doc });
  const dispatch = vi.fn();
  const editor = {
    get state() {
      return state;
    },
    view: {
      get state() {
        return state;
      },
      dispatch,
    },
  } as unknown as Editor;
  return { editor, dispatch };
}

function renderPopover(
  overrides: Partial<{ sceneId: string; nodeType: string }> = {},
) {
  const { editor, dispatch } = makeEditor();
  const triggerRef = createRef<HTMLElement>();
  const onClose = vi.fn();
  render(
    <div>
      <button ref={triggerRef as React.RefObject<HTMLButtonElement>}>
        trigger
      </button>
      <LayersPopover
        editor={editor}
        open
        onClose={onClose}
        triggerRef={triggerRef}
        sceneId={overrides.sceneId ?? "s1"}
        nodeType={overrides.nodeType ?? "scene"}
      />
    </div>,
  );
  return { editor, dispatch, onClose };
}

const settingsSetSpy = vi.fn();

beforeEach(() => {
  showPanelSpy.mockClear();
  settingsSetSpy.mockClear();
  useSettingsStore.setState({ set: settingsSetSpy } as never);
  useCursorSettingsStore.setState({
    showComments: false,
    showForeshadowMarks: false,
    showLint: true,
  });
  useAttributionStore.setState({ showAttribution: false });
  useAnnotationStore.setState({
    showAnnotations: true,
    annotationsByScene: new Map([
      [
        "s1",
        [
          { id: "a1", status: "open" },
          { id: "a2", status: "dismissed" },
        ] as never,
      ],
    ]),
  });
  useCodexHighlightStore.setState({ enabled: true });
});

describe("LayersPopover", () => {
  it("scene では6行のトグルが並ぶ", async () => {
    renderPopover();
    await waitFor(() => {
      expect(screen.getAllByRole("switch")).toHaveLength(6);
    });
  });

  it("scene 以外では校閲行が出ない", async () => {
    renderPopover({ nodeType: "codex" });
    await waitFor(() => {
      expect(screen.getAllByRole("switch")).toHaveLength(5);
    });
    expect(screen.queryByLabelText("editor.layers.review")).toBeNull();
  });

  it("件数バッジ: doc 走査(コメント/伏線)と annotationStore(非dismissed)を反映する", async () => {
    renderPopover();
    await waitFor(() => {
      expect(screen.getByTestId("layers-popover")).toBeTruthy();
    });
    const popover = screen.getByTestId("layers-popover");
    // comment run=1, foreshadow run=1, 校閲=非dismissed 1件
    const counts = Array.from(popover.querySelectorAll(".font-mono")).map(
      (el) => el.textContent,
    );
    expect(counts).toContain("1");
  });

  it("コメントトグルで store 反転 + COMMENT_REBUILD_META を dispatch + 設定へ write-through", async () => {
    const { dispatch } = renderPopover();
    const sw = await screen.findByLabelText("editor.layers.comments");
    fireEvent.click(sw);
    expect(useCursorSettingsStore.getState().showComments).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(settingsSetSpy).toHaveBeenCalledWith(
      "display.layerComments",
      "true",
    );
  });

  it("Lint トグルで showLint 反転 + LINT_REBUILD_META dispatch", async () => {
    const { dispatch } = renderPopover();
    const sw = await screen.findByLabelText("editor.layers.lint");
    fireEvent.click(sw);
    expect(useCursorSettingsStore.getState().showLint).toBe(false);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(settingsSetSpy).toHaveBeenCalledWith("display.layerLint", "false");
  });

  it("帰属ONで濃度スライダーが展開され、設定キーへ書き込む", async () => {
    renderPopover();
    const attrSw = await screen.findByLabelText("editor.layers.attribution");
    expect(screen.queryByLabelText("editor.layers.opacity")).toBeNull();
    fireEvent.click(attrSw);
    const slider = await screen.findByLabelText("editor.layers.opacity");
    fireEvent.change(slider, { target: { value: "20" } });
    expect(settingsSetSpy).toHaveBeenCalledWith(
      "display.attributionHighlightOpacity",
      "20",
    );
  });

  it("すべて隠すで全レイヤーOFF", async () => {
    renderPopover();
    const hideAll = await screen.findByText("editor.layers.hideAll");
    fireEvent.click(hideAll);
    await waitFor(() => {
      for (const sw of screen.getAllByRole("switch")) {
        expect(sw).toHaveAttribute("aria-checked", "false");
      }
    });
    expect(useCodexHighlightStore.getState().enabled).toBe(false);
    expect(useAnnotationStore.getState().showAnnotations).toBe(false);
  });

  it("校閲パネルを開く → showPanel(kouetsu) + onClose", async () => {
    const { onClose } = renderPopover();
    const link = await screen.findByText("editor.layers.openKouetsu");
    fireEvent.click(link);
    expect(showPanelSpy).toHaveBeenCalledWith("kouetsu");
    expect(onClose).toHaveBeenCalled();
  });
});

describe("Toolbar 統合", () => {
  // スイート全体で走ると transform/import が重なり既定 5s では足りないことが
  // あるため余裕を持たせる（単体では ~1s）。
  it(
    "レイヤーボタンでポップオーバーが開閉する",
    { timeout: 15000 },
    async () => {
      const editor = new TipTapEditor({
        extensions: [StarterKit],
        content: "<p>本文</p>",
      });
      render(
        <Toolbar
          editor={editor as never}
          onFindReplace={() => {}}
          sceneId="s1"
          nodeType="scene"
        />,
      );
      const trigger = screen.getByRole("button", {
        name: "editor.toolbar.layers",
      });
      expect(trigger).toHaveAttribute("aria-haspopup", "dialog");
      fireEvent.click(trigger);
      await waitFor(() => {
        expect(screen.getByTestId("layers-popover")).toBeTruthy();
      });
      expect(trigger).toHaveAttribute("aria-expanded", "true");
      editor.destroy();
    },
  );
});
