// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("@/features/editor/InlineSynopsisEditor", () => ({
  InlineSynopsisEditor: ({
    synopsis,
    placeholder,
  }: {
    synopsis: string | null;
    placeholder: string;
  }) => <div data-testid="synopsis-editor">{synopsis ?? placeholder}</div>,
}));

import { GridCardBody } from "../GridCardBody";
import { useGridStore } from "../gridStore";

beforeEach(() => {
  // Reset global card tab mode between tests.
  useGridStore.getState().setCardTabMode("auto");
});

describe("GridCardBody", () => {
  it("両方 OFF → 空のシーン プレースホルダ", () => {
    render(
      <GridCardBody
        nodeId="n1"
        synopsis={null}
        unplacedBeatPreview={null}
        showSynopsis={false}
        showBeats={false}
      />,
    );
    expect(screen.getByText("空のシーン")).toBeDefined();
  });

  it("両タブ表示 / beats あり → デフォルトで Beat タブ選択", () => {
    const preview = JSON.stringify(["Beat A", "Beat B"]);
    render(
      <GridCardBody
        nodeId="n1"
        synopsis="my synopsis"
        unplacedBeatPreview={preview}
        showSynopsis={true}
        showBeats={true}
      />,
    );
    expect(screen.getByText("Beat A")).toBeDefined();
    expect(screen.getByText("Beat B")).toBeDefined();
    expect(screen.queryByTestId("synopsis-editor")).toBeNull();
    // Tab strip は両タブとも表示
    expect(screen.getByRole("tab", { name: /Beat/ })).toBeDefined();
    expect(screen.getByRole("tab", { name: "Synopsis" })).toBeDefined();
  });

  it("Synopsis タブをクリックすると本文が切り替わる", () => {
    const preview = JSON.stringify(["Beat A"]);
    render(
      <GridCardBody
        nodeId="n1"
        synopsis="my synopsis"
        unplacedBeatPreview={preview}
        showSynopsis={true}
        showBeats={true}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Synopsis" }));
    expect(screen.getByTestId("synopsis-editor")).toBeDefined();
    expect(screen.queryByText("Beat A")).toBeNull();
  });

  it("beats なし / synopsis あり → デフォルトで Synopsis タブ", () => {
    render(
      <GridCardBody
        nodeId="n1"
        synopsis="Stand-alone synopsis"
        unplacedBeatPreview={null}
        showSynopsis={true}
        showBeats={true}
      />,
    );
    expect(screen.getByTestId("synopsis-editor")).toBeDefined();
  });

  it("Beat タブが空のとき '＋ Beat を追加' プロンプトが出て onRequestAddBeat を呼ぶ", () => {
    const onRequestAddBeat = vi.fn();
    render(
      <GridCardBody
        nodeId="n1"
        synopsis={null}
        unplacedBeatPreview={null}
        showSynopsis={false}
        showBeats={true}
        onRequestAddBeat={onRequestAddBeat}
      />,
    );
    const prompt = screen.getByText("＋ Beat を追加");
    fireEvent.click(prompt);
    expect(onRequestAddBeat).toHaveBeenCalledTimes(1);
  });

  it("単タブのとき (showBeats のみ) はタブ strip を出さない", () => {
    const preview = JSON.stringify(["Beat A"]);
    render(
      <GridCardBody
        nodeId="n1"
        synopsis={null}
        unplacedBeatPreview={preview}
        showSynopsis={false}
        showBeats={true}
      />,
    );
    expect(screen.getByText("Beat A")).toBeDefined();
    expect(screen.queryByRole("tablist")).toBeNull();
  });

  it("showBeats=false のとき Beat タブは出ず Synopsis のみ", () => {
    const preview = JSON.stringify(["Beat A"]);
    render(
      <GridCardBody
        nodeId="n1"
        synopsis="my synopsis"
        unplacedBeatPreview={preview}
        showSynopsis={true}
        showBeats={false}
      />,
    );
    expect(screen.queryByText("Beat A")).toBeNull();
    expect(screen.getByTestId("synopsis-editor")).toBeDefined();
    expect(screen.queryByRole("tab", { name: /Beat/ })).toBeNull();
  });

  it("compact=true → beat 行に line-clamp-1", () => {
    const preview = JSON.stringify(["Beat A"]);
    const { container } = render(
      <GridCardBody
        nodeId="n1"
        synopsis={null}
        unplacedBeatPreview={preview}
        showSynopsis={true}
        showBeats={true}
        compact={true}
      />,
    );
    expect(container.querySelector(".line-clamp-1")).not.toBeNull();
  });

  it("cardTabMode='synopsis' → beats があっても Synopsis タブが選択される", () => {
    useGridStore.getState().setCardTabMode("synopsis");
    const preview = JSON.stringify(["Beat A"]);
    render(
      <GridCardBody
        nodeId="n1"
        synopsis="my synopsis"
        unplacedBeatPreview={preview}
        showSynopsis={true}
        showBeats={true}
      />,
    );
    expect(screen.getByTestId("synopsis-editor")).toBeDefined();
    expect(screen.queryByText("Beat A")).toBeNull();
  });

  it("cardTabMode 非 auto のとき タブクリックは store を更新する (broadcast)", () => {
    useGridStore.getState().setCardTabMode("beat");
    const preview = JSON.stringify(["Beat A"]);
    render(
      <GridCardBody
        nodeId="n1"
        synopsis="my synopsis"
        unplacedBeatPreview={preview}
        showSynopsis={true}
        showBeats={true}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Synopsis" }));
    expect(useGridStore.getState().cardTabMode).toBe("synopsis");
  });

  it("cardTabMode='auto' のとき タブクリックは store を変更しない", () => {
    useGridStore.getState().setCardTabMode("auto");
    const preview = JSON.stringify(["Beat A"]);
    render(
      <GridCardBody
        nodeId="n1"
        synopsis="my synopsis"
        unplacedBeatPreview={preview}
        showSynopsis={true}
        showBeats={true}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Synopsis" }));
    expect(useGridStore.getState().cardTabMode).toBe("auto");
  });

  it("cardTabMode='beat' でも beats タブが非表示なら synopsis にフォールバック", () => {
    useGridStore.getState().setCardTabMode("beat");
    render(
      <GridCardBody
        nodeId="n1"
        synopsis="my synopsis"
        unplacedBeatPreview={null}
        showSynopsis={true}
        showBeats={false}
      />,
    );
    expect(screen.getByTestId("synopsis-editor")).toBeDefined();
  });

  it("compact=false → beat 行に line-clamp-2", () => {
    const preview = JSON.stringify(["Beat A"]);
    const { container } = render(
      <GridCardBody
        nodeId="n1"
        synopsis={null}
        unplacedBeatPreview={preview}
        showSynopsis={true}
        showBeats={true}
        compact={false}
      />,
    );
    expect(container.querySelector(".line-clamp-2")).not.toBeNull();
  });
});
