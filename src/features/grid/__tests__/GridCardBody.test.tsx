// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
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

describe("GridCardBody", () => {
  it("showSynopsis=false / showBeats=false → 空のシーン 表示", () => {
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

  it("beats がある → bullet list を beat-primary で表示", () => {
    const preview = JSON.stringify(["Beat A", "Beat B"]);
    render(
      <GridCardBody
        nodeId="n1"
        synopsis={null}
        unplacedBeatPreview={preview}
        showSynopsis={true}
        showBeats={true}
      />,
    );
    expect(screen.getByText("Beat A")).toBeDefined();
    expect(screen.getByText("Beat B")).toBeDefined();
  });

  it("beats + synopsis → 'Show synopsis' トグルを表示（synopsis は非表示）", () => {
    const preview = JSON.stringify(["Beat A"]);
    render(
      <GridCardBody
        nodeId="n1"
        synopsis="My synopsis"
        unplacedBeatPreview={preview}
        showSynopsis={true}
        showBeats={true}
      />,
    );
    expect(screen.getByText("Beat A")).toBeDefined();
    expect(screen.getByText("Show synopsis")).toBeDefined();
    expect(screen.queryByTestId("synopsis-editor")).toBeNull();
  });

  it("'Show synopsis' クリックで InlineSynopsisEditor が展開される", () => {
    const preview = JSON.stringify(["Beat A"]);
    render(
      <GridCardBody
        nodeId="n1"
        synopsis="My synopsis"
        unplacedBeatPreview={preview}
        showSynopsis={true}
        showBeats={true}
      />,
    );
    fireEvent.click(screen.getByText("Show synopsis"));
    expect(screen.getByTestId("synopsis-editor")).toBeDefined();
  });

  it("showSynopsis=false のとき beats あっても 'Show synopsis' は非表示", () => {
    const preview = JSON.stringify(["Beat A"]);
    render(
      <GridCardBody
        nodeId="n1"
        synopsis="My synopsis"
        unplacedBeatPreview={preview}
        showSynopsis={false}
        showBeats={true}
      />,
    );
    expect(screen.getByText("Beat A")).toBeDefined();
    expect(screen.queryByText("Show synopsis")).toBeNull();
  });

  it("showBeats=false → beats 非表示で synopsis を表示", () => {
    const preview = JSON.stringify(["Beat A"]);
    render(
      <GridCardBody
        nodeId="n1"
        synopsis="My synopsis"
        unplacedBeatPreview={preview}
        showSynopsis={true}
        showBeats={false}
      />,
    );
    expect(screen.queryByText("Beat A")).toBeNull();
    expect(screen.getByTestId("synopsis-editor")).toBeDefined();
  });

  it("beats なし / synopsis あり → synopsis のみ表示", () => {
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
    expect(screen.queryByText("Show synopsis")).toBeNull();
  });

  it("compact=true → beat 行に line-clamp-1 クラスが付く", () => {
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

  it("compact=false → beat 行に line-clamp-2 クラスが付く", () => {
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
