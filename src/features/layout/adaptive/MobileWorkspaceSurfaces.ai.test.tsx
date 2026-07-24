// @vitest-environment happy-dom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/lib/i18n";
import { DEFAULT_AI_SETTINGS, useAiSettingsStore } from "@/features/chat/store";
import { useChatStore } from "@/features/chat/chatStore";
import { useProjectStore } from "@/features/project/projectStore";
import { ConnectedMobileWorkspaceSurface } from "./MobileWorkspaceSurfaces";

describe("ConnectedMobileWorkspaceSurface AI readiness", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    useProjectStore.setState({
      currentProjectId: "project-1",
      projects: [
        {
          id: "project-1",
          aiPolicy: null,
        },
      ] as never,
    });
    useAiSettingsStore.setState({
      settings: {
        ...DEFAULT_AI_SETTINGS,
        provider: "anthropic",
        model: "claude-test",
      },
      hasApiKey: false,
    });
    useChatStore.setState({ messages: [], isStreaming: false });
  });

  afterEach(async () => {
    cleanup();
    await i18n.changeLanguage("ja");
  });

  it("keeps the draft editable but blocks submit until the provider is ready", () => {
    const onOpenSettings = vi.fn();
    render(
      <ConnectedMobileWorkspaceSurface
        surface="ai"
        onOpenSettings={onOpenSettings}
      />,
    );

    const input = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(input, { target: { value: "Keep this draft" } });
    const send = screen.getByRole("button", { name: "Send" });

    expect(input).toBeEnabled();
    expect(send).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(
      "AI is not configured",
    );
    fireEvent.click(screen.getByRole("button", { name: "Open AI settings" }));
    expect(onOpenSettings).toHaveBeenCalledOnce();

    act(() => {
      useAiSettingsStore.setState({ hasApiKey: true });
    });

    expect(input).toHaveValue("Keep this draft");
    expect(send).toBeEnabled();
  });
});
