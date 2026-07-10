// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { CitationList } from "./CitationList";
import type { Citation } from "../agent/agentTypes";

const openUrl = vi.fn();
vi.mock("@/lib/opener", () => ({
  openUrl: (url: string) => openUrl(url),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (k: string, opts?: { count?: number }) =>
      opts?.count != null ? `${k}:${opts.count}` : k,
  }),
}));

const cite = (url: string, title: string, citedText = ""): Citation => ({
  url,
  title,
  citedText,
});

describe("CitationList", () => {
  beforeEach(() => openUrl.mockReset());

  it("renders nothing when there are no citations", () => {
    const { container } = render(<CitationList citations={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders one entry per citation and never auto-loads an <img>", () => {
    const { container } = render(
      <CitationList
        citations={[
          cite("https://a.com/x", "A title"),
          cite("https://b.com/y", "B title"),
        ]}
      />,
    );
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("A title")).toBeTruthy();
    // セキュリティ: 引用表示はリンクボタンのみ、画像の自動ロードは無い。
    expect(container.querySelector("img")).toBeNull();
  });

  it("opens the source via openUrl on click (no inline navigation)", async () => {
    render(<CitationList citations={[cite("https://a.com/x", "A title")]} />);
    fireEvent.click(screen.getByText("A title"));
    await waitFor(() =>
      expect(openUrl).toHaveBeenCalledWith("https://a.com/x"),
    );
  });
});
