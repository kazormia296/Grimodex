// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { HeroReading } from "./HeroReading";

describe("HeroReading", () => {
  it("shows the first name reading in an editable field and counts alternates", () => {
    render(
      <HeroReading
        name="刹那"
        readings={{ 刹那: ["せつな", "せちな"], セツナ: ["せつな"] }}
        enabled
        onCommit={vi.fn()}
        onOpen={vi.fn()}
      />,
    );
    expect(screen.getByTestId("codex-hero-reading-input")).toHaveValue(
      "せつな",
    );
    expect(screen.getByTestId("codex-hero-reading-more")).toHaveTextContent(
      "+1",
    );
    expect(screen.queryByText("せちな")).not.toBeInTheDocument();
    expect(screen.queryByText("セツナ")).not.toBeInTheDocument();
  });

  it("uses a muted derived reading when an explicit reading is absent", () => {
    render(
      <HeroReading
        name="セツナ"
        readings={{}}
        enabled
        onCommit={vi.fn()}
        onOpen={vi.fn()}
      />,
    );
    expect(screen.getByTestId("codex-hero-reading-input")).toHaveValue(
      "せつな",
    );
    expect(screen.getByTestId("codex-hero-reading")).toHaveAttribute(
      "data-derived",
      "true",
    );
  });

  it("renders an empty reading input for a kanji name with no reading", () => {
    render(
      <HeroReading
        name="刹那"
        readings={{}}
        enabled
        onCommit={vi.fn()}
        onOpen={vi.fn()}
      />,
    );

    expect(screen.getByTestId("codex-hero-reading-input")).toHaveValue("");
    expect(screen.getByTestId("codex-hero-reading-input")).toHaveAttribute(
      "placeholder",
      "codex.readings.heroPlaceholder",
    );
  });

  it("trims and commits an edited representative reading on blur", () => {
    const onCommit = vi.fn();
    render(
      <HeroReading
        name="刹那"
        readings={{ 刹那: ["せつな"] }}
        enabled
        onCommit={onCommit}
        onOpen={vi.fn()}
      />,
    );

    const input = screen.getByTestId("codex-hero-reading-input");
    fireEvent.change(input, { target: { value: " せちな " } });
    fireEvent.blur(input);

    expect(onCommit).toHaveBeenCalledWith("せちな");
  });

  it("does not persist an unchanged automatically derived reading", () => {
    const onCommit = vi.fn();
    render(
      <HeroReading
        name="セツナ"
        readings={{}}
        enabled
        onCommit={onCommit}
        onOpen={vi.fn()}
      />,
    );

    fireEvent.blur(screen.getByTestId("codex-hero-reading-input"));
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("restores the current reading without saving when Escape is pressed", () => {
    const onCommit = vi.fn();
    render(
      <HeroReading
        name="刹那"
        readings={{ 刹那: ["せつな"] }}
        enabled
        onCommit={onCommit}
        onOpen={vi.fn()}
      />,
    );

    const input = screen.getByTestId("codex-hero-reading-input");
    fireEvent.change(input, { target: { value: "せちな" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(input).toHaveValue("せつな");
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("opens complete reading management from the adjacent action", () => {
    const onOpen = vi.fn();
    render(
      <HeroReading
        name="刹那"
        readings={{ 刹那: ["せつな"] }}
        enabled
        onCommit={vi.fn()}
        onOpen={onOpen}
      />,
    );
    fireEvent.click(screen.getByTestId("codex-hero-reading-manage"));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("is absent outside Japanese projects", () => {
    render(
      <HeroReading
        name="Setsuna"
        readings={{ Setsuna: ["せつな"] }}
        enabled={false}
        onCommit={vi.fn()}
        onOpen={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("codex-hero-reading")).not.toBeInTheDocument();
  });
});
