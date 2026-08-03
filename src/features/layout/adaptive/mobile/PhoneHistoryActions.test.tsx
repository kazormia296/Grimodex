// @vitest-environment happy-dom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/lib/i18n";
import { useGlobalHistoryStore } from "@/store/globalHistoryStore";
import { PhoneHistoryActions } from "./PhoneHistoryActions";
import {
  _resetQuiescenceLeasesForTests,
  acquireQuiescenceLease,
} from "@/application/lifecycle/quiescenceLease";

const toastError = vi.hoisted(() => vi.fn());

vi.mock("sonner", () => ({
  toast: { error: toastError },
}));

beforeEach(async () => {
  _resetQuiescenceLeasesForTests();
  await i18n.changeLanguage("en");
  useGlobalHistoryStore.getState().clear();
  toastError.mockReset();
});

afterEach(async () => {
  cleanup();
  _resetQuiescenceLeasesForTests();
  useGlobalHistoryStore.getState().clear();
  await i18n.changeLanguage("ja");
});

describe("PhoneHistoryActions", () => {
  it("executes undo and redo by touch and follows canUndo/canRedo", async () => {
    const undo = vi.fn().mockResolvedValue(undefined);
    const redo = vi.fn().mockResolvedValue(undefined);
    useGlobalHistoryStore.getState().push({
      kind: "scenes",
      label: "Create scene",
      undo,
      redo,
    });

    render(<PhoneHistoryActions />);
    const undoButton = screen.getByRole("button", { name: "Undo" });
    const redoButton = screen.getByRole("button", { name: "Redo" });

    expect(undoButton).toBeEnabled();
    expect(redoButton).toBeDisabled();

    fireEvent.click(undoButton);
    await waitFor(() => expect(undo).toHaveBeenCalledOnce());
    await waitFor(() => expect(redoButton).toBeEnabled());
    expect(undoButton).toBeDisabled();

    fireEvent.click(redoButton);
    await waitFor(() => expect(redo).toHaveBeenCalledOnce());
    await waitFor(() => expect(undoButton).toBeEnabled());
    expect(redoButton).toBeDisabled();
  });

  it("uses the existing localized toast when undo fails", async () => {
    useGlobalHistoryStore.getState().push({
      kind: "scenes",
      label: "Create scene",
      undo: vi.fn().mockRejectedValue(new Error("failed")),
      redo: vi.fn().mockResolvedValue(undefined),
    });

    render(<PhoneHistoryActions />);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Undo failed"));
  });

  it("disables replay actions while a destructive lifecycle lease is active", async () => {
    useGlobalHistoryStore.getState().push({
      kind: "scenes",
      label: "first",
      undo: async () => {},
      redo: async () => {},
    });
    useGlobalHistoryStore.getState().push({
      kind: "scenes",
      label: "second",
      undo: async () => {},
      redo: async () => {},
    });
    await useGlobalHistoryStore.getState().undo();
    acquireQuiescenceLease("project-load");

    render(<PhoneHistoryActions />);

    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Redo" })).toBeDisabled();
  });
});
