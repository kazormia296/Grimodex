// @vitest-environment happy-dom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri")>()),
  invoke: invokeMock,
}));

import i18n from "@/lib/i18n";
import { useProjectStore } from "@/features/project/projectStore";
import { DEFAULT_AI_SETTINGS, useAiSettingsStore } from "@/features/chat/store";
import { expandPreset } from "@/features/ai-policy/preset";
import Nir1LocalGenerationPanel, {
  type Nir1LocalAcceptedHandler,
} from "./Nir1LocalGenerationPanel";
import { resetNir1LocalGenerationsForTest } from "./nir1LocalGenerationStore";
import { NIR1_LOCAL_GENERATION_TRANSLATIONS } from "./nir1LocalGenerationTranslations";

// DD-1c: the closed generation screen, rendered directly (as if the constant
// were on). The real wrapper and state machine run; `invoke` is the boundary.

const ja = NIR1_LOCAL_GENERATION_TRANSLATIONS.ja;
const HANDLE = "0123456789abcdef0123456789abcdef";
const WRITING = "nir1-local-writing-0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const REVIEW = "nir1-local-review-0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

type Answer = unknown | ((args: Record<string, unknown>) => unknown);
const answers = new Map<string, Answer[]>();

function answer(command: string, ...values: Answer[]) {
  answers.set(command, [...(answers.get(command) ?? []), ...values]);
}

function calls(command: string): Record<string, unknown>[] {
  return invokeMock.mock.calls
    .filter(([name]) => name === command)
    .map(([, args]) => args as Record<string, unknown>);
}

function emptyRead() {
  return {
    status: "ok",
    purpose: "writing",
    rows: [],
    total: 0,
    truncated: false,
  };
}

function setPolicy(aiPolicy: string | null) {
  useProjectStore.setState({
    currentProjectId: "proj-1",
    projects: [{ id: "proj-1", aiPolicy }] as never,
  });
}

function renderPanel(
  props: { conversationId?: string | null; sceneId?: string | null } = {},
) {
  const acceptedRef = createRef<Nir1LocalAcceptedHandler | null>() as {
    current: Nir1LocalAcceptedHandler | null;
  };
  acceptedRef.current = null;
  const onOpenConversation = vi.fn();
  const view = render(
    <Nir1LocalGenerationPanel
      conversationId={props.conversationId ?? null}
      sceneId={props.sceneId === undefined ? "scene-1" : props.sceneId}
      acceptedRef={acceptedRef}
      onOpenConversation={onOpenConversation}
    />,
  );
  return { ...view, acceptedRef, onOpenConversation };
}

beforeEach(async () => {
  await i18n.changeLanguage("ja");
  resetNir1LocalGenerationsForTest();
  answers.clear();
  invokeMock.mockReset();
  invokeMock.mockImplementation(
    async (command: string, args: Record<string, unknown>) => {
      const queue = answers.get(command) ?? [];
      const next = queue.length > 1 ? queue.shift() : queue[0];
      if (next === undefined) throw new Error(`unexpected ${command}`);
      return typeof next === "function"
        ? (next as (a: Record<string, unknown>) => unknown)(args)
        : next;
    },
  );
  setPolicy(JSON.stringify({ preset: "full", toggles: expandPreset("full") }));
  useAiSettingsStore.setState({
    settings: {
      ...DEFAULT_AI_SETTINGS,
      provider: "openai-compatible",
      model: "local-model",
      openaiCompatibleEndpoints: [
        { id: "local-1", label: "", baseUrl: "http://127.0.0.1:8080/v1" },
      ],
      activeOpenaiCompatibleEndpointId: "local-1",
    },
  } as never);
});

afterEach(() => {
  cleanup();
});

describe("the generation screen outside a local conversation", () => {
  it("shows only the conversation controls and calls nothing", () => {
    renderPanel({ conversationId: "chat-1" });
    expect(screen.queryByTestId("nir1-local-disclosure")).toBeNull();
    expect(screen.queryByTestId("nir1-local-turn")).toBeNull();
    expect(screen.getByTestId("nir1-local-create-writing")).toBeTruthy();
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("the generation screen of a local conversation", () => {
  it("shows placement 3 with the route and reads every row Native returns", async () => {
    answer("nir1_local_conversation_read", {
      status: "ok",
      purpose: "writing",
      rows: [
        { messageId: "m1", kind: "input", createdAtMs: 1, text: "入力の本文" },
        {
          messageId: "m2",
          kind: "output",
          createdAtMs: 2,
          text: "出力の本文",
          thinking: [{}, {}],
          attemptStatus: "succeeded",
        },
        {
          messageId: "m3",
          kind: "output",
          createdAtMs: 3,
          unavailable: "stale",
        },
      ],
      total: 70,
      truncated: true,
    });
    renderPanel({ conversationId: WRITING });
    const disclosure = screen.getByTestId("nir1-local-disclosure");
    expect(disclosure.getAttribute("data-nir1-local-placement")).toBe("3");
    expect(
      [...disclosure.querySelectorAll("[data-nir1-local-disclosure-item]")].map(
        (item) => item.getAttribute("data-nir1-local-disclosure-item"),
      ),
    ).toEqual(["2", "3"]);
    expect(screen.getByTestId("nir1-local-route").textContent).toContain(
      "http://127.0.0.1:8080/v1/chat/completions",
    );
    await screen.findByText("入力の本文");
    expect(calls("nir1_local_conversation_read")).toEqual([
      { conversationId: WRITING, offset: 0, limit: 64 },
    ]);
    expect(screen.getByText("出力の本文")).toBeTruthy();
    expect(screen.getByText(ja.panel.unavailableRow)).toBeTruthy();
    expect(screen.getByText("thinking 2 件")).toBeTruthy();
    // The rest of the page is read with the next offset.
    answers.delete("nir1_local_conversation_read");
    answer("nir1_local_conversation_read", {
      status: "ok",
      purpose: "writing",
      rows: [{ messageId: "m4", kind: "input", createdAtMs: 4, text: "続き" }],
      total: 70,
      truncated: false,
    });
    fireEvent.click(screen.getByTestId("nir1-local-load-more"));
    await screen.findByText("続き");
    expect(calls("nir1_local_conversation_read").at(-1)).toEqual({
      conversationId: WRITING,
      offset: 3,
      limit: 64,
    });
    expect(screen.getByText("入力の本文")).toBeTruthy();
  });

  it("opens every disclosure item from placement 3", async () => {
    answer("nir1_local_conversation_read", emptyRead());
    renderPanel({ conversationId: WRITING });
    fireEvent.click(screen.getByText(ja.disclosure.showAll));
    expect(
      screen
        .getByTestId("nir1-local-disclosure")
        .querySelectorAll("[data-nir1-local-disclosure-item]").length,
    ).toBe(9);
    await waitFor(() =>
      expect(calls("nir1_local_conversation_read")).toHaveLength(1),
    );
  });

  it("starts after an accepted send, streams, stops with one cancel and re-reads", async () => {
    answer("nir1_local_conversation_read", emptyRead());
    answer("nir1_local_generation_start", {
      status: "started",
      handle: HANDLE,
    });
    answer(
      "nir1_local_generation_continue",
      {
        status: "ok",
        text: "生成の",
        thinking: "",
        state: "running",
        drained: false,
      },
      {
        status: "ok",
        text: "",
        thinking: "",
        state: "running",
        drained: false,
      },
    );
    const { acceptedRef } = renderPanel({ conversationId: WRITING });
    await waitFor(() => expect(acceptedRef.current).not.toBeNull());
    const send = { conversationId: WRITING, sceneId: "scene-1" };
    act(() => {
      acceptedRef.current!(send);
      // The same accepted send never starts a second generation.
      acceptedRef.current!(send);
    });
    await screen.findByText("生成の");
    expect(calls("nir1_local_generation_start")).toEqual([
      { purpose: "writing", conversationId: WRITING, sceneId: "scene-1" },
    ]);
    answer("nir1_local_generation_cancel", { status: "ok" });
    fireEvent.click(screen.getByTestId("nir1-local-cancel"));
    expect(screen.queryByTestId("nir1-local-cancel")).toBeNull();
    answers.set("nir1_local_generation_continue", [
      {
        status: "ok",
        text: "",
        thinking: "",
        state: "cancelled",
        reason: "cancelled",
        drained: true,
      },
    ]);
    await waitFor(() =>
      expect(
        screen
          .getByTestId("nir1-local-turn")
          .getAttribute("data-nir1-local-phase"),
      ).toBe("cancelled"),
    );
    expect(calls("nir1_local_generation_cancel")).toEqual([{ handle: HANDLE }]);
    // The terminal re-reads the saved rows.
    await waitFor(() =>
      expect(calls("nir1_local_conversation_read").length).toBeGreaterThan(1),
    );
    expect(invokeMock.mock.calls.map(([name]) => name)).not.toContain(
      "cancel_current_chat_input",
    );
  });

  // Review fix 1 (DR-DD1C-17): a second accepted send while one runs.
  it("keeps the running generation and its stop when another send is accepted", async () => {
    answer("nir1_local_conversation_read", emptyRead());
    answer("nir1_local_generation_start", {
      status: "started",
      handle: HANDLE,
    });
    answer("nir1_local_generation_continue", {
      status: "ok",
      text: "途中",
      thinking: "",
      state: "running",
      drained: false,
    });
    const { acceptedRef } = renderPanel({ conversationId: WRITING });
    await waitFor(() => expect(acceptedRef.current).not.toBeNull());
    act(() =>
      acceptedRef.current!({ conversationId: WRITING, sceneId: "scene-1" }),
    );
    await screen.findByText("途中");
    act(() =>
      acceptedRef.current!({ conversationId: WRITING, sceneId: "scene-1" }),
    );
    await screen.findByText(ja.reason.NIR1_LOCAL_SESSION_BUSY);
    expect(calls("nir1_local_generation_start")).toHaveLength(1);
    expect(
      screen
        .getByTestId("nir1-local-turn")
        .getAttribute("data-nir1-local-phase"),
    ).toBe("running");
    expect(screen.getByTestId("nir1-local-cancel")).toBeTruthy();
  });

  it("shows a typed refusal and offers no retry of the same capture", async () => {
    answer("nir1_local_conversation_read", emptyRead());
    answer("nir1_local_generation_start", {
      status: "unavailable",
      reason: "NIR1_LOCAL_SESSION_BUSY",
    });
    const { acceptedRef } = renderPanel({ conversationId: WRITING });
    await waitFor(() => expect(acceptedRef.current).not.toBeNull());
    act(() =>
      acceptedRef.current!({ conversationId: WRITING, sceneId: "scene-1" }),
    );
    await screen.findByText(ja.reason.NIR1_LOCAL_SESSION_BUSY);
    expect(screen.getByText(ja.panel.phase.refused)).toBeTruthy();
    expect(screen.queryByTestId("nir1-local-cancel")).toBeNull();
    expect(calls("nir1_local_generation_start")).toHaveLength(1);
  });

  it("keeps polling after the panel unmounts and shows the generation again", async () => {
    answer("nir1_local_conversation_read", emptyRead());
    answer("nir1_local_generation_start", {
      status: "started",
      handle: HANDLE,
    });
    answer("nir1_local_generation_continue", {
      status: "ok",
      text: "",
      thinking: "",
      state: "running",
      drained: false,
    });
    const first = renderPanel({ conversationId: WRITING });
    await waitFor(() => expect(first.acceptedRef.current).not.toBeNull());
    act(() =>
      first.acceptedRef.current!({
        conversationId: WRITING,
        sceneId: "scene-1",
      }),
    );
    await waitFor(() =>
      expect(calls("nir1_local_generation_continue").length).toBeGreaterThan(0),
    );
    first.unmount();
    expect(first.acceptedRef.current).toBeNull();
    const before = calls("nir1_local_generation_continue").length;
    await waitFor(() =>
      expect(calls("nir1_local_generation_continue").length).toBeGreaterThan(
        before,
      ),
    );
    expect(calls("nir1_local_generation_cancel")).toHaveLength(0);
    answers.set("nir1_local_generation_continue", [
      {
        status: "ok",
        text: "完了",
        thinking: "",
        state: "succeeded",
        drained: true,
      },
    ]);
    renderPanel({ conversationId: WRITING });
    await waitFor(() =>
      expect(
        screen
          .getByTestId("nir1-local-turn")
          .getAttribute("data-nir1-local-phase"),
      ).toBe("succeeded"),
    );
  });
});

describe("the AI usage policy's hide／disable (K5/3:427, DR-DD1B-12)", () => {
  it("hides the purpose the policy turned off and does not start it", async () => {
    setPolicy(
      JSON.stringify({
        preset: "assist-off",
        toggles: expandPreset("assist-off"),
      }),
    );
    answer("nir1_local_conversation_read", emptyRead());
    const { acceptedRef } = renderPanel({ conversationId: WRITING });
    expect(screen.queryByTestId("nir1-local-create-writing")).toBeNull();
    expect(screen.getByTestId("nir1-local-create-review")).toBeTruthy();
    expect(
      screen.getAllByText(ja.reason.NIR1_LOCAL_POLICY_DENIED).length,
    ).toBeGreaterThan(0);
    await waitFor(() => expect(acceptedRef.current).not.toBeNull());
    act(() =>
      acceptedRef.current!({ conversationId: WRITING, sceneId: "scene-1" }),
    );
    await waitFor(() =>
      expect(
        screen
          .getByTestId("nir1-local-turn")
          .getAttribute("data-nir1-local-phase"),
      ).toBe("refused"),
    );
    expect(calls("nir1_local_generation_start")).toHaveLength(0);
  });

  it("disables both purposes when the policy cannot be read", async () => {
    setPolicy('{"preset":"full"}');
    answer("nir1_local_conversation_read", emptyRead());
    const { acceptedRef } = renderPanel({ conversationId: REVIEW });
    for (const purpose of ["writing", "review"]) {
      expect(
        (
          screen.getByTestId(
            `nir1-local-create-${purpose}`,
          ) as HTMLButtonElement
        ).disabled,
      ).toBe(true);
    }
    expect(
      screen.getAllByText(ja.reason.NIR1_LOCAL_POLICY_UNREADABLE).length,
    ).toBeGreaterThan(0);
    await waitFor(() => expect(acceptedRef.current).not.toBeNull());
    act(() =>
      acceptedRef.current!({ conversationId: REVIEW, sceneId: "scene-1" }),
    );
    await waitFor(() =>
      expect(
        screen
          .getByTestId("nir1-local-turn")
          .querySelector("[data-nir1-local-reason]")
          ?.getAttribute("data-nir1-local-reason"),
      ).toBe("NIR1_LOCAL_POLICY_UNREADABLE"),
    );
    expect(calls("nir1_local_generation_start")).toHaveLength(0);
  });
});

describe("the conversations (create／list)", () => {
  it("creates with the purpose and scene and opens only Native's ID", async () => {
    answer("nir1_local_conversation_create", {
      status: "created",
      conversationId: REVIEW,
      displayName: { purpose: "review", createdAt: "2026-10-26T00:00:00Z" },
    });
    const { onOpenConversation } = renderPanel({ conversationId: null });
    fireEvent.click(screen.getByTestId("nir1-local-create-review"));
    await waitFor(() =>
      expect(onOpenConversation).toHaveBeenCalledWith(REVIEW),
    );
    expect(calls("nir1_local_conversation_create")).toEqual([
      { purpose: "review", sceneId: "scene-1" },
    ]);
  });

  it("cannot create without a scene", () => {
    renderPanel({ conversationId: null, sceneId: null });
    expect(
      (screen.getByTestId("nir1-local-create-writing") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("lists on demand and shows an unknown reason without its text", async () => {
    answer("nir1_local_conversation_list", {
      status: "refused",
      reason: "socket error at /home/user/.config",
    });
    renderPanel({ conversationId: null });
    expect(calls("nir1_local_conversation_list")).toHaveLength(0);
    fireEvent.click(screen.getByTestId("nir1-local-show-conversations"));
    await screen.findByText(ja.reason.unknown);
    expect(document.body.textContent).not.toContain("/home/user");
    answers.delete("nir1_local_conversation_list");
    answer("nir1_local_conversation_list", {
      status: "ok",
      conversations: [
        {
          conversationId: WRITING,
          displayName: { purpose: "writing", createdAt: null },
        },
      ],
      truncated: false,
    });
    fireEvent.click(screen.getByTestId("nir1-local-show-conversations"));
    fireEvent.click(screen.getByTestId("nir1-local-show-conversations"));
    await screen.findByText(ja.panel.createdAtUnknown);
  });

  it("shows the IPC failure class only", async () => {
    invokeMock.mockImplementation(async () => {
      throw new Error(
        "D2A_EGRESS_DENIED: nir1-restricted-only: route nir1_local_conversation_list is unavailable",
      );
    });
    renderPanel({ conversationId: null });
    fireEvent.click(screen.getByTestId("nir1-local-show-conversations"));
    await screen.findByText(ja.panel.ipc["egress-denied"]);
    expect(document.body.textContent).not.toContain("D2A_EGRESS_DENIED");
  });
});
