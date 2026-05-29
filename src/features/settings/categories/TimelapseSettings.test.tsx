// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const toggleMock = vi.hoisted(() => ({
  isTimelapseEnabled: vi.fn(() => Promise.resolve(true)),
  setTimelapseEnabled: vi.fn(() => Promise.resolve()),
  purgeTimelapseHistory: vi.fn(() => Promise.resolve()),
  countTimelapseEvents: vi.fn(() => Promise.resolve(0)),
}));
const confirmMock = vi.hoisted(() => ({
  confirm: vi.fn(() => Promise.resolve(true)),
}));

vi.mock("@/features/project/projectStore", () => ({
  useCurrentProjectId: () => "p1",
}));
vi.mock("@/features/timelapse/toggle", () => toggleMock);
vi.mock("@/features/trash-bin/ConfirmDialog", () => ({
  useConfirmDialog: () => ({ confirm: confirmMock.confirm, dialog: null }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { TimelapseSettings } from "./TimelapseSettings";

beforeEach(() => {
  vi.clearAllMocks();
  toggleMock.isTimelapseEnabled.mockResolvedValue(true);
  toggleMock.countTimelapseEvents.mockResolvedValue(0);
  confirmMock.confirm.mockResolvedValue(true);
});

describe("TimelapseSettings", () => {
  it("reflects persisted state; toggling OFF calls the orchestrator with no confirm", async () => {
    render(<TimelapseSettings />);
    const sw = await screen.findByRole("switch");
    await waitFor(() => expect(sw).toHaveAttribute("aria-checked", "true"));

    fireEvent.click(sw);
    await waitFor(() =>
      expect(toggleMock.setTimelapseEnabled).toHaveBeenCalledWith("p1", false),
    );
    expect(confirmMock.confirm).not.toHaveBeenCalled();
  });

  it("re-enabling with existing history confirms before discarding", async () => {
    toggleMock.isTimelapseEnabled.mockResolvedValue(false);
    toggleMock.countTimelapseEvents.mockResolvedValue(5);
    render(<TimelapseSettings />);
    const sw = await screen.findByRole("switch");
    await waitFor(() => expect(sw).toHaveAttribute("aria-checked", "false"));

    fireEvent.click(sw);
    await waitFor(() => expect(confirmMock.confirm).toHaveBeenCalled());
    await waitFor(() =>
      expect(toggleMock.setTimelapseEnabled).toHaveBeenCalledWith("p1", true),
    );
  });

  it("purge confirms then clears the history", async () => {
    render(<TimelapseSettings />);
    const btn = await screen.findByTestId("timelapse-purge-button");

    fireEvent.click(btn);
    await waitFor(() => expect(confirmMock.confirm).toHaveBeenCalled());
    await waitFor(() =>
      expect(toggleMock.purgeTimelapseHistory).toHaveBeenCalledWith("p1"),
    );
  });
});
