import { render } from "@testing-library/react";
import { expect, it } from "vitest";
import "./editorStickyCard.css";

it("suppresses the stationary wrapper focus ring during sticky deletion", () => {
  render(
    <div
      aria-label="Editor付箋"
      aria-disabled="true"
      className="editor-sticky-card"
      tabIndex={0}
    />,
  );

  const card = document.querySelector<HTMLElement>(".editor-sticky-card");
  expect(card).not.toBeNull();
  card?.focus();

  expect(document.activeElement).toBe(card);
  expect(getComputedStyle(card as HTMLElement).outlineStyle).toBe("none");
});
