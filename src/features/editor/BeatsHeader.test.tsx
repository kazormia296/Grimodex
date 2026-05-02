// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { BeatsHeader } from "./BeatsHeader";
import { useUnplacedBeatsStore } from "@/features/editor/beat/unplacedBeatsStore";

// TipTap の useEditor はモック（Unplaced beat editor の初期化が複雑なため）
vi.mock("@tiptap/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tiptap/react")>();
  return {
    ...actual,
    useEditor: vi.fn(() => null),
    EditorContent: vi.fn(() => <div data-testid="editor-content" />),
  };
});

// EditorPane の editor は main scene editor (placed beats の walk に使う)
// PlacedBeatList は editor が null のとき空リストを返す想定
const mockEditor = null;

beforeEach(() => {
  useUnplacedBeatsStore.setState({ sceneBeats: {} });
});

describe("BeatsHeader", () => {
  it("Unplaced・Placed が両方0件のときヘッダーのみ表示（リストは描画されない）", () => {
    render(
      <BeatsHeader
        sceneId="s1"
        editor={mockEditor}
        setMentionPopup={vi.fn()}
      />,
    );
    // ヘッダーは表示される
    expect(screen.getByTestId("beats-header")).toBeTruthy();
    // 0件のとき beats-unplaced-list は描画されない
    expect(screen.queryByTestId("beats-unplaced-list")).toBeNull();
  });

  it("+ Beat ボタンを押すと Unplaced beat がストアに追加される", () => {
    render(
      <BeatsHeader
        sceneId="s1"
        editor={mockEditor}
        setMentionPopup={vi.fn()}
      />,
    );
    // + Beat ボタンをクリック（デフォルトで展開済み）
    fireEvent.click(screen.getByTestId("beats-add-button"));
    // ストアに1件追加されていること
    expect(useUnplacedBeatsStore.getState().getBeats("s1")).toHaveLength(1);
  });

  it("ストアに beats がある場合、件数バッジを表示する", () => {
    useUnplacedBeatsStore.setState({
      sceneBeats: {
        s1: [
          {
            id: "b1",
            beatType: "free",
            pov: null,
            collapsed: false,
            content: [{ type: "text", text: "テスト" }],
          },
        ],
      },
    });
    render(
      <BeatsHeader
        sceneId="s1"
        editor={mockEditor}
        setMentionPopup={vi.fn()}
      />,
    );
    // バッジに "1 unplaced" が含まれる
    expect(screen.getByTestId("beats-count-badge").textContent).toContain(
      "1 unplaced",
    );
  });

  it("Unplaced beats がある場合、デフォルトで展開され Unplaced リストが表示される", () => {
    useUnplacedBeatsStore.setState({
      sceneBeats: {
        s1: [
          {
            id: "b1",
            beatType: "free",
            pov: null,
            collapsed: false,
            content: [{ type: "text", text: "テスト" }],
          },
        ],
      },
    });
    render(
      <BeatsHeader
        sceneId="s1"
        editor={mockEditor}
        setMentionPopup={vi.fn()}
      />,
    );
    expect(screen.getByTestId("beats-unplaced-list")).toBeTruthy();
  });

  it("Unplaced beat の Delete ボタンでストアから削除される", () => {
    useUnplacedBeatsStore.setState({
      sceneBeats: {
        s1: [
          {
            id: "b1",
            beatType: "free",
            pov: null,
            collapsed: false,
            content: [{ type: "text", text: "削除対象" }],
          },
        ],
      },
    });
    render(
      <BeatsHeader
        sceneId="s1"
        editor={mockEditor}
        setMentionPopup={vi.fn()}
      />,
    );
    // [⋮] メニューを開く（デフォルトで展開済み）
    fireEvent.click(screen.getByTestId("beat-item-menu-b1"));
    // Delete をクリック
    fireEvent.click(screen.getByTestId("beat-menu-delete-b1"));
    // ストアから削除されていること
    expect(useUnplacedBeatsStore.getState().getBeats("s1")).toHaveLength(0);
  });
});
