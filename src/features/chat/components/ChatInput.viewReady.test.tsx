// @vitest-environment happy-dom
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetDynamicModelCapsForTests,
  registerDynamicModelCaps,
} from "../agent/dynamicModelCaps";
import { useAiSettingsStore } from "../store";
import { useChatStore } from "../chatStore";
import { DEFAULT_AI_SETTINGS } from "../types";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { ChatInput, readChatInputEditorState } from "./ChatInput";

const h = vi.hoisted(() => {
  let successfulViewReads = 0;
  const editor = {
    isDestroyed: false,
    get view() {
      if (successfulViewReads > 0) {
        successfulViewReads -= 1;
        return { dom: {} };
      }
      throw new Error("The editor view is not available");
    },
    on: vi.fn(),
    off: vi.fn(),
    setEditable: vi.fn(),
    getText: vi.fn(() => ""),
    storage: {},
    state: {
      doc: { descendants: vi.fn() },
    },
    commands: {
      clearContent: vi.fn(),
      focus: vi.fn(),
      setContent: vi.fn(),
    },
  };
  return {
    editor,
    setSuccessfulViewReads(value: number) {
      successfulViewReads = value;
    },
  };
});

vi.mock("@tiptap/react", () => ({
  EditorContent: () => null,
  useEditor: () => h.editor,
  useEditorState: () => ({ hasText: false, text: "", hasMentions: false }),
}));

vi.mock("@/features/editor/useCodexHighlight", () => ({
  useCodexHighlight: vi.fn(),
}));

vi.mock("@/features/editor/CodexPopover", () => ({
  CodexPopover: () => null,
}));

vi.mock("../useChatModelCatalog", () => ({
  useChatModelCatalog: () => ({ sections: [], loading: false }),
}));

describe("ChatInput editor view readiness", () => {
  beforeEach(() => {
    h.setSuccessfulViewReads(0);
    globalThis.localStorage?.removeItem("grimodex.modelCaps.v2");
    globalThis.localStorage?.removeItem("grimodex.openrouterModelCaps.v1");
    __resetDynamicModelCapsForTests();
    useChatStore.setState({ agentMode: false });
    useAiSettingsStore.setState({
      settings: null,
      models: [],
      chatModelOverride: null,
      chatProviderOverride: null,
      chatModelVariantOverride: null,
      chatEndpointIdOverride: null,
      modelCapsRevision: 0,
    });
    useSettingsStore.setState((state) => ({
      cache: {
        ...state.cache,
        "aiModel.role.agent": "",
        "aiModel.roleProviders": "",
      },
    }));
  });

  it("does not access view.dom before TipTap mounts the editor view", () => {
    expect(() => render(<ChatInput onSend={vi.fn()} />)).not.toThrow();
  });

  it("rechecks view readiness when React reconnects passive effects", () => {
    // Initial render sees a mounted view, but TipTap detaches it before passive
    // effects reconnect. The effect must probe again instead of trusting the
    // render-time readiness snapshot.
    h.setSuccessfulViewReads(2);
    expect(() => render(<ChatInput onSend={vi.fn()} />)).not.toThrow();
  });

  it("returns an empty state when the subscribed editor has been destroyed", () => {
    const getText = vi.fn(() => {
      throw new Error("schema is no longer available");
    });
    const destroyedEditor = {
      isDestroyed: true,
      get view(): never {
        throw new Error("view is no longer available");
      },
      getText,
    };

    expect(readChatInputEditorState(destroyedEditor as never)).toEqual({
      hasText: false,
      text: "",
      hasMentions: false,
    });
    expect(getText).not.toHaveBeenCalled();
  });

  it("lets an already-enabled Agent mode turn off after the model becomes tool-incompatible", () => {
    registerDynamicModelCaps(
      "ollama",
      [
        {
          id: "completion-only:latest",
          name: "Completion only",
          supportedParameters: [],
        },
      ],
      { ollamaEndpoint: DEFAULT_AI_SETTINGS.ollamaEndpoint },
    );
    useAiSettingsStore.setState({
      settings: {
        ...DEFAULT_AI_SETTINGS,
        provider: "ollama",
        model: "completion-only:latest",
      },
      models: [
        {
          id: "completion-only:latest",
          name: "Completion only",
          supportedParameters: [],
        },
      ],
      modelCapsRevision: 1,
    });
    useChatStore.setState({ agentMode: true });

    const { container } = render(
      <ChatInput onSend={vi.fn(async () => true)} />,
    );
    const toggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="agent-mode-toggle"]',
    );

    expect(toggle).not.toBeNull();
    expect(toggle).not.toBeDisabled();
    fireEvent.click(toggle!);
    expect(useChatStore.getState().agentMode).toBe(false);
  });

  it("enables Agent for a tool-capable cross-provider role even when the active model has no tools", () => {
    registerDynamicModelCaps(
      "ollama",
      [
        {
          id: "completion-only:latest",
          name: "Completion only",
          supportedParameters: [],
        },
      ],
      { ollamaEndpoint: DEFAULT_AI_SETTINGS.ollamaEndpoint },
    );
    registerDynamicModelCaps("openrouter", [
      {
        id: "tool-agent",
        name: "Tool Agent",
        supportedParameters: ["tools"],
      },
    ]);
    useAiSettingsStore.setState({
      settings: {
        ...DEFAULT_AI_SETTINGS,
        provider: "ollama",
        model: "completion-only:latest",
      },
      models: [
        {
          id: "completion-only:latest",
          name: "Completion only",
          supportedParameters: [],
        },
      ],
      modelCapsRevision: 1,
    });
    useSettingsStore.setState((state) => ({
      cache: {
        ...state.cache,
        "aiModel.role.agent": "tool-agent",
        "aiModel.roleProviders": JSON.stringify({
          agent: { provider: "openrouter" },
        }),
      },
    }));

    render(<ChatInput onSend={vi.fn(async () => true)} />);

    expect(screen.getByTestId("agent-mode-toggle")).not.toBeDisabled();
  });

  it("allows a cached no-tools cross-provider Ollama role to be re-probed", () => {
    registerDynamicModelCaps("openrouter", [
      {
        id: "completion-only-cloud",
        name: "Completion only cloud",
        supportedParameters: [],
      },
    ]);
    registerDynamicModelCaps(
      "ollama",
      [
        {
          id: "replaceable-agent:latest",
          name: "Replaceable Agent",
          supportedParameters: [],
        },
      ],
      { ollamaEndpoint: DEFAULT_AI_SETTINGS.ollamaEndpoint },
    );
    useAiSettingsStore.setState({
      settings: {
        ...DEFAULT_AI_SETTINGS,
        provider: "openrouter",
        model: "completion-only-cloud",
      },
      modelCapsRevision: 1,
    });
    useSettingsStore.setState((state) => ({
      cache: {
        ...state.cache,
        "aiModel.role.agent": "replaceable-agent:latest",
        "aiModel.roleProviders": JSON.stringify({
          agent: { provider: "ollama" },
        }),
      },
    }));

    render(<ChatInput onSend={vi.fn(async () => true)} />);
    const toggle = screen.getByTestId("agent-mode-toggle");

    expect(toggle).not.toBeDisabled();
    fireEvent.click(toggle);
    expect(useChatStore.getState().agentMode).toBe(true);
  });
});
