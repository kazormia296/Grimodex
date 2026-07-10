// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { HeroReading } from "./HeroReading";

describe("HeroReading", () => {
  it("shows the first name reading as representative and counts alternates", () => {
    render(
      <HeroReading
        name="刹那"
        readings={{ 刹那: ["せつな", "せちな"], セツナ: ["せつな"] }}
        enabled
        onOpen={vi.fn()}
      />,
    );
    expect(screen.getByTestId("codex-hero-reading")).toHaveTextContent(
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
      <HeroReading name="セツナ" readings={{}} enabled onOpen={vi.fn()} />,
    );
    expect(screen.getByTestId("codex-hero-reading")).toHaveTextContent(
      "せつな",
    );
    expect(screen.getByTestId("codex-hero-reading")).toHaveAttribute(
      "data-derived",
      "true",
    );
  });

  it("opens complete reading management when clicked", () => {
    const onOpen = vi.fn();
    render(
      <HeroReading
        name="刹那"
        readings={{ 刹那: ["せつな"] }}
        enabled
        onOpen={onOpen}
      />,
    );
    fireEvent.click(screen.getByTestId("codex-hero-reading"));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("is absent outside Japanese projects", () => {
    render(
      <HeroReading
        name="Setsuna"
        readings={{ Setsuna: ["せつな"] }}
        enabled={false}
        onOpen={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("codex-hero-reading")).not.toBeInTheDocument();
  });
});
