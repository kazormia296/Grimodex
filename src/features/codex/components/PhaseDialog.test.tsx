// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { PhaseDialog } from "./PhaseDialog";

const mockCreatePhase = vi.fn().mockResolvedValue(undefined);
const mockUpdatePhase = vi.fn().mockResolvedValue(undefined);

const mockPhaseState = {
  createPhase: mockCreatePhase,
  updatePhase: mockUpdatePhase,
};

vi.mock("../phaseStore", () => ({
  usePhaseStore: Object.assign(
    (selector: (s: typeof mockPhaseState) => unknown) =>
      selector(mockPhaseState),
    { getState: () => mockPhaseState },
  ),
}));

const mockTreeState = {
  nodes: [
    {
      id: "scene-1",
      title: "シーン1",
      nodeType: "scene",
    },
  ],
};

vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: Object.assign(
    (selector: (s: typeof mockTreeState) => unknown) => selector(mockTreeState),
    { getState: () => mockTreeState },
  ),
}));

describe("PhaseDialog: AI 露出設定が主役化されている", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("AI 露出のセクションが Override fields より前に登場する", () => {
    render(
      <PhaseDialog
        entryId="entry-1"
        phase={null}
        onClose={() => {}}
        resolveCurrentContent={() => "{}"}
      />,
    );

    const aiSection = screen.getByTestId("phase-dialog-ai-exposure");
    const overrideSection = screen.getByTestId("phase-dialog-overrides");
    // DOM 上の出現順序
    expect(
      aiSection.compareDocumentPosition(overrideSection) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("AI 露出は select として独立表示される（チェックボックスの裏ではない）", () => {
    render(
      <PhaseDialog
        entryId="entry-1"
        phase={null}
        onClose={() => {}}
        resolveCurrentContent={() => "{}"}
      />,
    );
    const select = screen.getByTestId(
      "phase-dialog-ai-exposure-select",
    ) as HTMLSelectElement;
    expect(select.tagName).toBe("SELECT");
    // 5 options: default + 4 modes
    expect(select.querySelectorAll("option").length).toBe(5);
  });

  it("AI 露出 select の初期値は 'デフォルト維持' (空文字)", () => {
    render(
      <PhaseDialog
        entryId="entry-1"
        phase={null}
        onClose={() => {}}
        resolveCurrentContent={() => "{}"}
      />,
    );
    const select = screen.getByTestId(
      "phase-dialog-ai-exposure-select",
    ) as HTMLSelectElement;
    expect(select.value).toBe("");
  });

  it("AI 露出だけ変更 → contextModeOverride のみで submit 可能", async () => {
    render(
      <PhaseDialog
        entryId="entry-1"
        phase={null}
        onClose={() => {}}
        resolveCurrentContent={() => "{}"}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText(/追放後/), {
      target: { value: "死亡" },
    });
    // anchor scene
    const anchorSelect = document.querySelectorAll("select")[0];
    fireEvent.change(anchorSelect, { target: { value: "scene-1" } });
    // AI 露出
    fireEvent.change(screen.getByTestId("phase-dialog-ai-exposure-select"), {
      target: { value: "hidden" },
    });

    const save = screen.getByRole("button", { name: /保存|Save/ });
    expect(save).not.toBeDisabled();
    fireEvent.click(save);

    await waitFor(() => {
      expect(mockCreatePhase).toHaveBeenCalledWith(
        expect.objectContaining({
          entryId: "entry-1",
          label: "死亡",
          anchorNodeId: "scene-1",
          contextModeOverride: "hidden",
          summaryOverride: null,
          contentOverride: null,
        }),
      );
    });
  });

  it("AI 露出デフォルト + summary/content 上書きなし → submit ブロック", () => {
    render(
      <PhaseDialog
        entryId="entry-1"
        phase={null}
        onClose={() => {}}
        resolveCurrentContent={() => "{}"}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText(/追放後/), {
      target: { value: "死亡" },
    });
    const anchorSelect = document.querySelectorAll("select")[0];
    fireEvent.change(anchorSelect, { target: { value: "scene-1" } });

    const save = screen.getByRole("button", { name: /保存|Save/ });
    expect(save).toBeDisabled();
  });

  it("新規 Content は選択したアンカー時点の解決値を保存する", async () => {
    const resolveCurrentContent = vi.fn(
      (anchorNodeId: string) => `${anchorNodeId}-resolved-content`,
    );
    render(
      <PhaseDialog
        entryId="entry-1"
        phase={null}
        onClose={() => {}}
        resolveCurrentContent={resolveCurrentContent}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText(/追放後/), {
      target: { value: "過去の状態" },
    });
    fireEvent.change(document.querySelectorAll("select")[0], {
      target: { value: "scene-1" },
    });
    fireEvent.click(screen.getAllByRole("checkbox")[1]);
    fireEvent.click(screen.getByRole("button", { name: /保存|Save/ }));

    await waitFor(() => {
      expect(resolveCurrentContent).toHaveBeenCalledWith("scene-1", undefined);
      expect(mockCreatePhase).toHaveBeenCalledWith(
        expect.objectContaining({
          anchorNodeId: "scene-1",
          contentOverride: "scene-1-resolved-content",
        }),
      );
    });
  });

  it("既存 Phase 編集時、contextModeOverride 値が select に復元される", () => {
    render(
      <PhaseDialog
        entryId="entry-1"
        phase={{
          id: "p1",
          entryId: "entry-1",
          label: "Wiki only",
          anchorNodeId: "scene-1",
          summaryOverride: null,
          contentOverride: null,
          contextModeOverride: "hidden",
          createdAt: "2024-01-01T00:00:00Z",
          updatedAt: "2024-01-01T00:00:00Z",
        }}
        onClose={() => {}}
        resolveCurrentContent={() => "{}"}
      />,
    );
    const select = screen.getByTestId(
      "phase-dialog-ai-exposure-select",
    ) as HTMLSelectElement;
    expect(select.value).toBe("hidden");
  });
});
