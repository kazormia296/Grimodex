// @vitest-environment happy-dom
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BackgroundStudioHost } from "./BackgroundStudioHost";
import { useBackgroundStudioStore } from "./backgroundStudioStore";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe("BackgroundStudioHost", () => {
  beforeEach(() => useBackgroundStudioStore.setState({ open: false }));

  it("does not expose a background trigger in Zen mode", () => {
    render(<BackgroundStudioHost zenMode />);

    expect(
      screen.queryByRole("button", { name: "editor.background.open" }),
    ).toBeNull();
  });

  it("closes an open studio when Zen mode starts", async () => {
    useBackgroundStudioStore.setState({ open: true });
    const { rerender } = render(<BackgroundStudioHost zenMode={false} />);

    rerender(<BackgroundStudioHost zenMode />);

    await waitFor(() =>
      expect(useBackgroundStudioStore.getState().open).toBe(false),
    );
  });
});
