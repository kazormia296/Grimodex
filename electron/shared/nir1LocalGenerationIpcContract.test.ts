// NIR-1 DD-1b (DR-DD1B-2, -3, -5): the six local generation commands in the
// typed IPC contract. Main re-validates the request before Native and Native's
// answer before the renderer; Main's key verdict comes only from the symbol
// sidecar; the Main-only sender stop is not a renderer command.
import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  dispatchInvoke,
  isNir1LocalWireId,
  NAPI_COMMANDS,
  NIR1_LOCAL_GENERATION_COMMANDS,
  NIR1_LOCAL_MAIN_KEY_VERDICT,
  NIR1_LOCAL_REFUSAL_REASONS,
  nir1LocalRefusalValue,
} from "./ipcContract.js";
import type { Envelope, NapiBackendLike } from "./ipcContract.js";

const CALLER = {
  profileId: "profile-1",
  callerId: "caller-1",
  callerEpoch: 3,
  senderId: 7,
  workspaceId: "workspace-1",
  sessionId: "session-1",
};
const HANDLE = "0123456789abcdef0123456789abcdef";
const CONVERSATION = "nir1-local-writing-0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

/** Renderer args with Main's non-enumerable sidecars, as the router builds them. */
function withMain(
  args: Record<string, unknown>,
  verdict: unknown = { endpointId: "local-1", keyVerdict: "absent" },
  // `null` leaves Main's verdict sidecar out.
): Record<string, unknown> {
  const dispatched = { ...args };
  Object.defineProperty(dispatched, "callerIdentity", {
    value: CALLER,
    enumerable: false,
  });
  if (verdict !== null) {
    Object.defineProperty(dispatched, NIR1_LOCAL_MAIN_KEY_VERDICT, {
      value: verdict,
      enumerable: false,
    });
  }
  return dispatched;
}

function backendWith(
  method: string,
  answer: unknown,
): { backend: NapiBackendLike; call: ReturnType<typeof vi.fn> } {
  const call = vi.fn().mockResolvedValue(JSON.stringify(answer));
  return { backend: { [method]: call } as unknown as NapiBackendLike, call };
}

async function run(
  command: string,
  args: Record<string, unknown>,
  backend: NapiBackendLike,
): Promise<Envelope> {
  return dispatchInvoke(command, args, { backend, shell: {} as never });
}

function errorOf(envelope: Envelope): string {
  expect(envelope.ok).toBe(false);
  return envelope.ok ? "" : envelope.error;
}

describe("NIR-1 local generation IPC contract (DD-1b)", () => {
  it("has the six commands of K5/3's table and no Main-only one", () => {
    for (const command of NIR1_LOCAL_GENERATION_COMMANDS) {
      expect(NAPI_COMMANDS, command).toHaveProperty(command);
    }
    expect(NAPI_COMMANDS).not.toHaveProperty(
      "main_nir1_local_generation_cancel_sender",
    );
    expect(NAPI_COMMANDS).not.toHaveProperty(
      "mainNir1LocalGenerationCancelSender",
    );
  });

  it("knows exactly Native's closed reasons plus Main's two", () => {
    const source = readFileSync(
      new URL(
        "../native/grimodex-node/src/nir1_local_entry.rs",
        import.meta.url,
      ),
      "utf8",
    );
    const native = [
      ...source.matchAll(/Self::\w+ => "(NIR1_LOCAL_[A-Z_]+)"/g),
    ].map((match) => match[1]);
    expect(native.length).toBeGreaterThan(30);
    expect([...NIR1_LOCAL_REFUSAL_REASONS].sort()).toEqual(
      [
        ...native,
        "NIR1_LOCAL_SENDER_REFUSED",
        "NIR1_LOCAL_ENDPOINT_UNAVAILABLE",
      ].sort(),
    );
  });

  it("the Main refusal value has Native's shape per command", () => {
    expect(
      nir1LocalRefusalValue(
        "nir1_local_generation_start",
        "NIR1_LOCAL_GATE_CLOSED",
      ),
    ).toEqual({ status: "unavailable", reason: "NIR1_LOCAL_GATE_CLOSED" });
    for (const command of NIR1_LOCAL_GENERATION_COMMANDS.slice(1)) {
      expect(nir1LocalRefusalValue(command, "NIR1_LOCAL_GATE_CLOSED")).toEqual({
        status: "refused",
        reason: "NIR1_LOCAL_GATE_CLOSED",
      });
    }
  });

  it("follows Native's wire_id for every id", () => {
    expect(isNir1LocalWireId("a".repeat(256))).toBe(true);
    // 86 three-byte characters are 258 bytes: Native counts bytes.
    expect(isNir1LocalWireId("あ".repeat(86))).toBe(false);
    expect(isNir1LocalWireId("あ".repeat(85))).toBe(true);
    for (const bad of [
      "",
      " a",
      "a ",
      "a\u0000b",
      "a\u009fb",
      "a".repeat(257),
    ]) {
      expect(isNir1LocalWireId(bad), JSON.stringify(bad)).toBe(false);
    }
    expect(isNir1LocalWireId(7)).toBe(false);
  });

  describe("nir1_local_generation_start", () => {
    const intent = {
      purpose: "writing",
      conversationId: CONVERSATION,
      sceneId: "scene-1",
    };

    it("sends the intent, Main's verdict and Main's caller, and returns the handle", async () => {
      const { backend, call } = backendWith("nir1LocalGenerationStart", {
        status: "started",
        handle: HANDLE,
      });
      const envelope = await run(
        "nir1_local_generation_start",
        withMain(intent),
        backend,
      );
      expect(envelope).toEqual({
        ok: true,
        value: { status: "started", handle: HANDLE },
      });
      expect(call).toHaveBeenCalledWith(
        intent,
        { endpointId: "local-1", keyVerdict: "absent" },
        JSON.stringify(CALLER),
      );
    });

    it("refuses renderer-chosen route, endpoint, messages, policy or key verdict fields", async () => {
      for (const extra of [
        "endpoint",
        "endpointId",
        "keyVerdict",
        "mainVerdict",
        "messages",
        "policy",
        "route",
        "submissionId",
      ]) {
        const { backend, call } = backendWith("nir1LocalGenerationStart", {});
        const error = errorOf(
          await run(
            "nir1_local_generation_start",
            withMain({ ...intent, [extra]: "x" }),
            backend,
          ),
        );
        expect(error, extra).toContain("unknown field");
        expect(call).not.toHaveBeenCalled();
      }
    });

    it("takes the key verdict only from Main's sidecar", async () => {
      const { backend, call } = backendWith("nir1LocalGenerationStart", {});
      expect(
        errorOf(
          await run(
            "nir1_local_generation_start",
            withMain(intent, null),
            backend,
          ),
        ),
      ).toContain("IPC_NIR1_LOCAL_KEY_VERDICT_REQUIRED");
      for (const verdict of [
        { endpointId: "local-1", keyVerdict: "maybe" },
        { endpointId: " local-1", keyVerdict: "absent" },
        { endpointId: "local-1", keyVerdict: "absent", extra: 1 },
        "absent",
      ]) {
        expect(
          (
            await run(
              "nir1_local_generation_start",
              withMain(intent, verdict),
              backend,
            )
          ).ok,
          JSON.stringify(verdict),
        ).toBe(false);
      }
      expect(call).not.toHaveBeenCalled();
    });

    it("requires Main's caller identity", async () => {
      const { backend, call } = backendWith("nir1LocalGenerationStart", {});
      const args = { ...intent };
      Object.defineProperty(args, NIR1_LOCAL_MAIN_KEY_VERDICT, {
        value: { endpointId: "local-1", keyVerdict: "absent" },
      });
      expect(
        errorOf(await run("nir1_local_generation_start", args, backend)),
      ).toContain("IPC_NIR1_LOCAL_CALLER_IDENTITY_REQUIRED");
      expect(call).not.toHaveBeenCalled();
    });

    it("validates the purpose and the ids", async () => {
      const { backend, call } = backendWith("nir1LocalGenerationStart", {});
      for (const bad of [
        { ...intent, purpose: "agent" },
        { ...intent, purpose: "Writing" },
        { ...intent, conversationId: "" },
        { ...intent, sceneId: " scene-1" },
        { ...intent, sceneId: "a".repeat(257) },
        { purpose: "writing", conversationId: CONVERSATION },
      ]) {
        expect(
          (await run("nir1_local_generation_start", withMain(bad), backend)).ok,
          JSON.stringify(bad),
        ).toBe(false);
      }
      expect(call).not.toHaveBeenCalled();
    });

    it("passes only closed answers", async () => {
      const unavailable = {
        status: "unavailable",
        reason: "NIR1_LOCAL_POLICY_DENIED",
      };
      const { backend } = backendWith("nir1LocalGenerationStart", unavailable);
      expect(
        await run("nir1_local_generation_start", withMain(intent), backend),
      ).toEqual({ ok: true, value: unavailable });
      for (const answer of [
        { status: "started", handle: "not-a-handle" },
        { status: "started", handle: HANDLE, attemptId: "a" },
        { status: "unavailable", reason: "free text" },
        {
          status: "unavailable",
          reason: "NIR1_LOCAL_POLICY_DENIED",
          detail: 1,
        },
        { status: "done" },
      ]) {
        const answered = backendWith("nir1LocalGenerationStart", answer);
        expect(
          errorOf(
            await run(
              "nir1_local_generation_start",
              withMain(intent),
              answered.backend,
            ),
          ),
          JSON.stringify(answer),
        ).toContain("invalid result");
      }
    });
  });

  describe("nir1_local_generation_continue and _cancel", () => {
    it("takes only an opaque handle", async () => {
      for (const command of [
        "nir1_local_generation_continue",
        "nir1_local_generation_cancel",
      ]) {
        const method =
          command === "nir1_local_generation_continue"
            ? "nir1LocalGenerationContinue"
            : "nir1LocalGenerationCancel";
        const { backend, call } = backendWith(method, { status: "ok" });
        for (const bad of [
          {},
          { handle: HANDLE.toUpperCase() },
          { handle: `${HANDLE}0` },
          { handle: HANDLE, senderId: 1 },
        ]) {
          expect(
            (await run(command, withMain(bad), backend)).ok,
            `${command} ${JSON.stringify(bad)}`,
          ).toBe(false);
        }
        expect(call).not.toHaveBeenCalled();
      }
    });

    it("bounds the delta and closes the state and reason", async () => {
      const ok = {
        status: "ok",
        text: "Hello",
        thinking: "hm",
        state: "succeeded",
        reason: "stop",
        drained: false,
      };
      const { backend, call } = backendWith("nir1LocalGenerationContinue", ok);
      expect(
        await run(
          "nir1_local_generation_continue",
          withMain({ handle: HANDLE }),
          backend,
        ),
      ).toEqual({ ok: true, value: ok });
      expect(call).toHaveBeenCalledWith(
        { handle: HANDLE },
        JSON.stringify(CALLER),
      );
      const { reason: _reason, ...running } = { ...ok, state: "running" };
      for (const answer of [
        { ...ok, text: "x".repeat(64 * 1024 + 1) },
        { ...ok, thinking: "あ".repeat(22_000) },
        { ...ok, state: "paused" },
        { ...ok, reason: "Free text" },
        { ...ok, drained: "no" },
        { ...ok, audit: [] },
      ]) {
        const answered = backendWith("nir1LocalGenerationContinue", answer);
        expect(
          (
            await run(
              "nir1_local_generation_continue",
              withMain({ handle: HANDLE }),
              answered.backend,
            )
          ).ok,
          JSON.stringify(answer).slice(0, 80),
        ).toBe(false);
      }
      const answered = backendWith("nir1LocalGenerationContinue", running);
      expect(
        await run(
          "nir1_local_generation_continue",
          withMain({ handle: HANDLE }),
          answered.backend,
        ),
      ).toEqual({ ok: true, value: running });
    });

    it("cancel answers ok or a closed refusal", async () => {
      const { backend } = backendWith("nir1LocalGenerationCancel", {
        status: "ok",
      });
      expect(
        await run(
          "nir1_local_generation_cancel",
          withMain({ handle: HANDLE }),
          backend,
        ),
      ).toEqual({ ok: true, value: { status: "ok" } });
      const refused = backendWith("nir1LocalGenerationCancel", {
        status: "refused",
        reason: "NIR1_LOCAL_CANCEL_CAPTURE_FAILED",
      });
      expect(
        await run(
          "nir1_local_generation_cancel",
          withMain({ handle: HANDLE }),
          refused.backend,
        ),
      ).toEqual({
        ok: true,
        value: {
          status: "refused",
          reason: "NIR1_LOCAL_CANCEL_CAPTURE_FAILED",
        },
      });
    });
  });

  describe("the conversations", () => {
    const view = {
      conversationId: CONVERSATION,
      displayName: {
        purpose: "writing",
        createdAt: "2026-10-26T10:00:00.000Z",
      },
    };

    it("create takes a purpose and a Scene and returns a marked id of that purpose", async () => {
      const { backend, call } = backendWith("nir1LocalConversationCreate", {
        status: "created",
        ...view,
      });
      expect(
        await run(
          "nir1_local_conversation_create",
          withMain({ purpose: "writing", sceneId: "scene-1" }),
          backend,
        ),
      ).toEqual({ ok: true, value: { status: "created", ...view } });
      expect(call).toHaveBeenCalledWith(
        { purpose: "writing", sceneId: "scene-1" },
        JSON.stringify(CALLER),
      );
      for (const answer of [
        { status: "created", ...view, conversationId: "chat-1" },
        {
          status: "created",
          ...view,
          displayName: { purpose: "review", createdAt: null },
        },
        { status: "created", ...view, title: "本文" },
        {
          status: "created",
          ...view,
          displayName: { ...view.displayName, title: "本文" },
        },
      ]) {
        const answered = backendWith("nir1LocalConversationCreate", answer);
        expect(
          (
            await run(
              "nir1_local_conversation_create",
              withMain({ purpose: "writing", sceneId: "scene-1" }),
              answered.backend,
            )
          ).ok,
          JSON.stringify(answer),
        ).toBe(false);
      }
      // The answer's purpose must be the one asked for.
      const review = backendWith("nir1LocalConversationCreate", {
        status: "created",
        ...view,
      });
      expect(
        (
          await run(
            "nir1_local_conversation_create",
            withMain({ purpose: "review", sceneId: "scene-1" }),
            review.backend,
          )
        ).ok,
      ).toBe(false);
      const extra = backendWith("nir1LocalConversationCreate", {});
      expect(
        (
          await run(
            "nir1_local_conversation_create",
            withMain({ purpose: "writing", sceneId: "scene-1", title: "t" }),
            extra.backend,
          )
        ).ok,
      ).toBe(false);
      expect(extra.call).not.toHaveBeenCalled();
    });

    it("list takes nothing and returns at most 256 marked conversations", async () => {
      const { backend, call } = backendWith("nir1LocalConversationList", {
        status: "ok",
        conversations: [view],
        truncated: false,
      });
      expect(
        await run("nir1_local_conversation_list", withMain({}), backend),
      ).toEqual({
        ok: true,
        value: { status: "ok", conversations: [view], truncated: false },
      });
      expect(call).toHaveBeenCalledWith(JSON.stringify(CALLER));
      expect(
        (
          await run(
            "nir1_local_conversation_list",
            withMain({ projectId: "p" }),
            backend,
          )
        ).ok,
      ).toBe(false);
      const tooMany = backendWith("nir1LocalConversationList", {
        status: "ok",
        conversations: Array.from({ length: 257 }, () => view),
        truncated: true,
      });
      expect(
        (
          await run(
            "nir1_local_conversation_list",
            withMain({}),
            tooMany.backend,
          )
        ).ok,
      ).toBe(false);
    });

    it("read bounds the range and passes only verified rows", async () => {
      const page = {
        status: "ok",
        purpose: "writing",
        rows: [
          {
            messageId: "m-1",
            kind: "input",
            createdAtMs: 1,
            text: "入力",
            attemptStatus: "succeeded",
          },
          {
            messageId: "m-2",
            kind: "output",
            createdAtMs: 2,
            text: "出力",
            thinking: [{ type: "thinking", text: "hm" }],
          },
          {
            messageId: "m-3",
            kind: "output",
            createdAtMs: 3,
            unavailable: "NIR1_GENERATION_MESSAGE_BODY_MISMATCH",
          },
        ],
        total: 3,
        truncated: false,
      };
      const request = { conversationId: CONVERSATION, offset: 0, limit: 3 };
      const { backend, call } = backendWith("nir1LocalConversationRead", page);
      expect(
        await run("nir1_local_conversation_read", withMain(request), backend),
      ).toEqual({ ok: true, value: page });
      expect(call).toHaveBeenCalledWith(request, JSON.stringify(CALLER));
      for (const bad of [
        { ...request, limit: 0 },
        { ...request, limit: 65 },
        { ...request, limit: 1.5 },
        { ...request, offset: -1 },
        { ...request, offset: 2 ** 32 },
        { ...request, conversationId: "" },
        { ...request, includeAudit: true },
      ]) {
        const refused = backendWith("nir1LocalConversationRead", page);
        expect(
          (
            await run(
              "nir1_local_conversation_read",
              withMain(bad),
              refused.backend,
            )
          ).ok,
          JSON.stringify(bad),
        ).toBe(false);
        expect(refused.call).not.toHaveBeenCalled();
      }
      for (const answer of [
        { ...page, rows: page.rows, total: 3, extra: 1 },
        { ...page, rows: [...page.rows, page.rows[0]] }, // more rows than limit
        {
          ...page,
          rows: [{ ...page.rows[2], text: "leaked" }],
        },
        { ...page, rows: [{ ...page.rows[0], role: "system" }] },
        { ...page, rows: [{ ...page.rows[0], kind: "system" }] },
        { ...page, rows: [{ ...page.rows[0], text: undefined }] },
        { ...page, rows: [{ ...page.rows[0], attemptStatus: "Free text" }] },
        { ...page, purpose: "agent" },
      ]) {
        const answered = backendWith("nir1LocalConversationRead", answer);
        expect(
          (
            await run(
              "nir1_local_conversation_read",
              withMain(request),
              answered.backend,
            )
          ).ok,
          JSON.stringify(answer).slice(0, 120),
        ).toBe(false);
      }
    });
  });
});
