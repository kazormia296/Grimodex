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
  if (!card) throw new Error("Editor sticky card was not rendered");
  card.focus();

  expect(document.activeElement).toBe(card);
  expect(getComputedStyle(card).outlineStyle).toBe("none");
});
