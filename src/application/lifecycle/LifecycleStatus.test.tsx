// @vitest-environment happy-dom
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _resetQuiescenceLeasesForTests,
  acquireQuiescenceLease,
} from "./quiescenceLease";
import { LifecycleStatus } from "./LifecycleStatus";

describe("LifecycleStatus", () => {
  beforeEach(() => {
    _resetQuiescenceLeasesForTests();
  });

  afterEach(() => {
    _resetQuiescenceLeasesForTests();
  });

  it("remains visible and exposed to assistive technology outside an inert shell", async () => {
    const { container } = render(
      <main data-testid="inert-shell" inert>
        <LifecycleStatus />
      </main>,
    );
    expect(screen.queryByRole("status")).toBeNull();

    let lease!: ReturnType<typeof acquireQuiescenceLease>;
    act(() => {
      lease = acquireQuiescenceLease("workspace-open");
    });

    const status = await screen.findByRole("status");
    const shell = screen.getByTestId("inert-shell");
    expect(shell).toHaveAttribute("inert");
    expect(shell.contains(status)).toBe(false);
    expect(status.closest("[inert]")).toBeNull();
    expect(status).toBeVisible();
    expect(status).not.toHaveClass("sr-only");
    expect(status).toHaveTextContent(/保存|Saving/);

    act(() => lease.release());
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect(container.firstElementChild).toBe(shell);
  });
});
