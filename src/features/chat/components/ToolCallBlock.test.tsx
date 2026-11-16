// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/lib/tauri", () => ({
  invoke: vi.fn(),
  isTauri: () => false,
}));

import {
  captureUiSnapshot,
  useUiUndoStore,
} from "@/features/commands/uiOperationUndo";
import { useLayoutStore } from "@/features/layout/layoutStore";
import { buildDefaultLayoutState } from "@/features/layout/layoutStateUtils";
import type { ToolCallRecord } from "../agent/agentTypes";
import { ToolCallBlock } from "./ToolCallBlock";

function record(overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return {
    name: "run_app_command",
    params: { command: "focusScenes" },
    resultSummary: "Ran command focusScenes (undo available)",
    tokensUsed: 0,
    ...overrides,
  };
}

beforeEach(() => {
  useLayoutStore.setState({
    layout: buildDefaultLayoutState({ editorOpen: true }),
    hiddenStripePanels: new Set(),
    activePresetId: "builtin:default",
    openOverlay: null,
    maximizedPanelId: null,
  });
  useUiUndoStore.setState({ entries: {} });
});

describe("ToolCallBlock — 元に戻す", () => {
  it("undoId が無い通常のツールにはボタンを出さない", () => {
    render(
      <ToolCallBlock record={record({ name: "get_scene", params: {} })} />,
    );
    expect(
      screen.queryByRole("button", { name: /前の画面|Restore|元に戻す|Undo/ }),
    ).toBeNull();
  });

  it("退避が無い（再読込後など）なら undoId があってもボタンを出さない", () => {
    render(<ToolCallBlock record={record({ undoId: "missing" })} />);
    expect(screen.queryByText("元に戻す")).toBeNull();
    expect(screen.queryByText("Undo")).toBeNull();
  });

  it("1 回押すと配置が操作の前に戻り、ボタンは「元に戻しました」に替わる（確認は出ない）", () => {
    const before = captureUiSnapshot();
    const wasActive = useLayoutStore.getState().isPanelActive("scenes");
    useLayoutStore.getState().togglePanel("scenes");
    expect(useLayoutStore.getState().isPanelActive("scenes")).toBe(!wasActive);
    const id = useUiUndoStore.getState().register(before, captureUiSnapshot());

    render(<ToolCallBlock record={record({ undoId: id })} />);
    const button = screen.getByRole("button", {
      name: /この操作の前の画面|Restore the screen/,
    });
    fireEvent.click(button);

    expect(useLayoutStore.getState().isPanelActive("scenes")).toBe(wasActive);
    expect(
      screen.queryByRole("button", {
        name: /この操作の前の画面|Restore the screen/,
      }),
    ).toBeNull();
    expect(screen.getByText(/元に戻しました|Undone/)).toBeTruthy();
  });

  it("操作の後に配置が変わっていたら戻さず、カードに理由を出す（ボタンは残る）", () => {
    const before = captureUiSnapshot();
    useLayoutStore.getState().togglePanel("scenes");
    const id = useUiUndoStore.getState().register(before, captureUiSnapshot());
    // 利用者が後で別のパネルを切り替えた。
    useLayoutStore.getState().togglePanel("codex");
    const layoutNow = useLayoutStore.getState().layout;

    render(<ToolCallBlock record={record({ undoId: id })} />);
    fireEvent.click(
      screen.getByRole("button", {
        name: /この操作の前の画面|Restore the screen/,
      }),
    );

    expect(useLayoutStore.getState().layout).toBe(layoutNow);
    expect(
      screen.getByText(
        /その後に配置が変わったため戻せません|layout was changed/,
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/元に戻しました|Undone/)).toBeNull();
    expect(useUiUndoStore.getState().entries[id]?.status).toBe("available");
  });
});
